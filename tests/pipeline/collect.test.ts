import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { runCollection } from "../../src/pipeline/collect.js";
import type { ProductRef } from "../../src/strategies/types.js";
import { extractionStrategy, seedRetailer, seedStrategy } from "./helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const directories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function seedProducts(database: ReturnType<typeof openDatabase>, count: number): void {
  const statement = database.prepare(
    `INSERT INTO products
       (id, retailer_id, canonical_url, retailer_product_id, title, first_seen, last_seen)
     VALUES (?, 'retailer-1', ?, ?, ?, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z')`,
  );
  const insert = database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      statement.run(`p-${index}`, `https://shop.test/${index}`, String(index), `Product ${index}`);
    }
  });
  insert();
}

describe("collection pipeline", () => {
  it("persists successes and categorized failures transactionally", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 3);

    const summary = await runCollection("retailer-1", {
      database,
      concurrency: 3,
      execute: async (_strategy, ref) => {
        if (ref.externalId === "1") {
          return {
            ok: false,
            failure: { category: "parse", message: "bad payload", responded: true },
          };
        }
        return {
          ok: true,
          fields: {
            title: `Fresh ${ref.externalId}`,
            brand: "Brand",
            price: 10,
            promoPrice: 9,
            unit: "1 kg",
            available: true,
          },
        };
      },
      now: () => new Date("2026-07-10T06:00:00.000Z"),
    });

    expect(summary).toMatchObject({ attempted: 3, ok: 2, failed: 1, successRate: 2 / 3 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({ n: 2 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM run_failures").get()).toEqual({ n: 1 });
    expect(summary.attempted).toBe(summary.ok + summary.failed);
  });

  it("turns executor rejection into unknown failure and never exceeds concurrency five", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 20);
    let active = 0;
    let maximum = 0;

    const summary = await runCollection("retailer-1", {
      database,
      concurrency: 99,
      execute: async (_strategy, ref) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        if (ref.externalId === "7") throw new Error("executor exploded");
        return {
          ok: true,
          fields: {
            title: "Product",
            brand: null,
            price: 1,
            promoPrice: null,
            unit: null,
            available: true,
          },
        };
      },
    });

    expect(maximum).toBe(5);
    expect(summary).toMatchObject({ attempted: 20, ok: 19, failed: 1 });
    expect(database.prepare("SELECT category FROM run_failures").get()).toEqual({ category: "unknown" });
  });

  it("caps attempts at 2,000 even when a higher limit is requested", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 2_001);
    let calls = 0;

    const summary = await runCollection("retailer-1", {
      database,
      limit: 9_999,
      execute: async () => {
        calls += 1;
        return { ok: false, failure: { category: "parse", message: "x", responded: true } };
      },
    });

    expect(calls).toBe(2_000);
    expect(summary.attempted).toBe(2_000);
  }, 20_000);

  it("applies the 2,000 cap cumulatively across same-day collection runs", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    const strategyId = seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 10);
    database.prepare(
      `INSERT INTO runs
         (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
          status, attempted, ok, failed, started_at, finished_at)
       VALUES
         ('prior', 'retailer-1', 'discover', '2026-07-10', ?, 1,
          'failed', 1999, 0, 1999, '2026-07-10T03:00:00.000Z',
          '2026-07-10T03:10:00.000Z')`,
    ).run(strategyId);
    let calls = 0;

    const summary = await runCollection("retailer-1", {
      database,
      limit: 100,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async () => {
        calls += 1;
        return { ok: false, failure: { category: "parse", message: "x", responded: true } };
      },
    });

    expect(calls).toBe(1);
    expect(summary.attempted).toBe(1);
  });

  it("uses reservoir sampling to retain exactly 20 of 100 HTML bodies", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 100);
    const root = await mkdtemp(join(tmpdir(), "precos-replay-"));
    directories.push(root);
    let state = 123456789;
    const random = (): number => {
      state = (1103515245 * state + 12345) % 0x80000000;
      return state / 0x80000000;
    };

    await runCollection("retailer-1", {
      database,
      rawHtmlRoot: root,
      random,
      execute: async (_strategy, ref: ProductRef) => ({
        ok: true,
        fields: {
          title: `Product ${ref.externalId}`,
          brand: null,
          price: 2,
          promoPrice: null,
          unit: null,
          available: true,
        },
        html: `<html><title>${ref.externalId}</title></html>`,
      }),
    });

    const files = (await readdir(join(root, "2026-07-10", "retailer-1")))
      .filter((file) => file.endsWith(".html.gz"));
    expect(files).toHaveLength(20);
    expect(files.every((file) => /^[a-f0-9]{64}\.html\.gz$/u.test(file))).toBe(true);
    expect((database.prepare(
      "SELECT COUNT(*) AS n FROM observations WHERE response_path IS NOT NULL",
    ).get() as { n: number }).n).toBeGreaterThanOrEqual(20);
    expect(database.prepare("SELECT COUNT(*) AS n FROM observations WHERE response_path LIKE '%<html>%'").get()).toEqual({ n: 0 });
  });

  it("keeps one persistent unbiased reservoir across same-day runs", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 30);
    const root = await mkdtemp(join(tmpdir(), "precos-replay-daily-"));
    directories.push(root);

    for (let run = 0; run < 2; run += 1) {
      await runCollection("retailer-1", {
        database,
        rawHtmlRoot: root,
        random: () => 0,
        now: () => new Date("2026-07-10T12:00:00.000Z"),
        execute: async (_strategy, ref) => ({
          ok: true,
          fields: {
            title: `Run ${run} product ${ref.externalId}`,
            brand: null,
            price: 2,
            promoPrice: null,
            unit: null,
            available: true,
          },
          html: `<html><title>${run}-${ref.externalId}</title></html>`,
        }),
      });
    }

    const directory = join(root, "2026-07-10", "retailer-1");
    const files = (await readdir(directory)).filter((file) => file.endsWith(".html.gz"));
    const state = JSON.parse(await readFile(join(directory, ".reservoir.json"), "utf8")) as {
      population: number;
      slots: unknown[];
    };
    expect(files).toHaveLength(20);
    expect(state).toMatchObject({ population: 60 });
    expect(state.slots).toHaveLength(20);
  });

  it("performs no executor/network work and writes no evidence during dry-run", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 3);
    let executions = 0;

    const summary = await runCollection("retailer-1", {
      database,
      dryRun: true,
      execute: async () => {
        executions += 1;
        return { ok: false, failure: { category: "network", message: "no", responded: false } };
      },
    });

    expect(executions).toBe(0);
    expect(summary).toMatchObject({ attempted: 0, ok: 0, failed: 0, planned: 3 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM run_failures").get()).toEqual({ n: 0 });
  });

  it("clamps direct production collection concurrency to at least three", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 6);
    let active = 0;
    let maximum = 0;

    await runCollection("retailer-1", {
      database,
      concurrency: 1,
      execute: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { ok: false, failure: { category: "parse", message: "x", responded: true } };
      },
    });

    expect(maximum).toBe(3);
  });

  it("paces live attempts through an injected polite start gate", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 3);
    const sleeps: number[] = [];
    let clock = 1_000;

    await runCollection("retailer-1", {
      database,
      concurrency: 3,
      politeDelayMs: { min: 750, max: 750 },
      clock: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      execute: async () => ({
        ok: false,
        failure: { category: "parse", message: "fixture", responded: true },
      }),
    });

    expect(sleeps).toEqual([750, 750]);
  });

  it("finalizes replay-storage failure without rewriting a successful observation", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 1);
    const directory = await mkdtemp(join(tmpdir(), "precos-replay-error-"));
    directories.push(directory);
    const invalidRoot = join(directory, "not-a-directory");
    await writeFile(invalidRoot, "occupied");

    const summary = await runCollection("retailer-1", {
      database,
      rawHtmlRoot: invalidRoot,
      execute: async () => ({
        ok: true,
        fields: {
          title: "Product",
          brand: null,
          price: 1,
          promoPrice: null,
          unit: null,
          available: true,
        },
        html: "<html>sample</html>",
      }),
    });

    expect(summary).toMatchObject({ attempted: 1, ok: 0, failed: 1, status: "failed" });
    expect(database.prepare("SELECT status, attempted, ok, failed FROM runs").get()).toEqual({
      status: "failed",
      attempted: 1,
      ok: 0,
      failed: 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM run_failures").get()).toEqual({ n: 1 });
  });

  it("persists each completed attempt before executing the next queued product", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 2);
    let calls = 0;
    let observationsBeforeSecond = -1;

    await runCollection("retailer-1", {
      database,
      concurrency: 1,
      concurrentMap: async (values, _concurrency, worker) => {
        const results = [];
        for (const [index, value] of values.entries()) {
          results.push(await worker(value, index));
        }
        return results;
      },
      execute: async () => {
        calls += 1;
        if (calls === 2) {
          observationsBeforeSecond = (
            database.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }
          ).n;
        }
        return {
          ok: true,
          fields: {
            title: "Product",
            brand: null,
            price: 1,
            promoPrice: null,
            unit: null,
            available: true,
          },
        };
      },
    });

    expect(calls).toBe(2);
    expect(observationsBeforeSecond).toBe(1);
  });
});
