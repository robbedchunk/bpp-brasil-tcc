import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { openDailyReplayReservoir } from "../../src/collection/replay.js";
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

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
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
    expect(database.prepare("SELECT responded FROM run_failures").get()).toEqual({ responded: 1 });
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

    const summary = await runCollection("retailer-1", {
      database,
      rawHtmlRoot: root,
      random,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
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

    expect(summary).toMatchObject({ attempted: 100, ok: 100, failed: 0, status: "completed" });
    expect(database.prepare("SELECT error_message FROM runs").get())
      .toEqual({ error_message: null });
    const files = (await readdir(join(root, "2026-07-10", "retailer-1")))
      .filter((file) => file.endsWith(".html.gz"));
    expect(files).toHaveLength(20);
    expect(files.every((file) => /^[a-f0-9]{64}\.html\.gz$/u.test(file))).toBe(true);
    expect(database.prepare(
      "SELECT COUNT(*) AS n FROM observations WHERE response_path IS NOT NULL",
    ).get()).toEqual({ n: 0 });
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
    expect(state.slots.every((slot) => {
      const candidate = slot as { evidence?: { kind?: string; id?: string } };
      return candidate.evidence?.kind === "observation"
        && typeof candidate.evidence.id === "string";
    })).toBe(true);
    const observationIds = new Set((database.prepare("SELECT id FROM observations").all() as Array<{
      id: string;
    }>).map(({ id }) => id));
    expect(state.slots.every((slot) => {
      const candidate = slot as { evidence: { id: string } };
      return observationIds.has(candidate.evidence.id);
    })).toBe(true);
  });

  it("rolls back file and manifest replacement atomically when publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-replay-atomic-"));
    directories.push(root);
    const initial = await openDailyReplayReservoir(root, "2026-07-10", "retailer-1", {
      size: 20,
      random: () => 0,
    });
    for (let index = 0; index < 20; index += 1) {
      await initial.consider(`<html>${index}</html>`, {
        kind: "observation",
        id: `observation-${index}`,
      });
    }
    const directory = join(root, "2026-07-10", "retailer-1");
    const beforeFiles = (await readdir(directory))
      .filter((file) => file.endsWith(".html.gz"))
      .sort();

    const failing = await openDailyReplayReservoir(root, "2026-07-10", "retailer-1", {
      size: 20,
      random: () => 0,
      beforeStatePublish: (state) => {
        if (state.population === 21) throw new Error("state sink unavailable");
      },
    });
    await expect(failing.consider("<html>replacement</html>", {
      kind: "observation",
      id: "replacement-observation",
    })).rejects.toThrow(/state sink unavailable/u);

    const afterFiles = (await readdir(directory))
      .filter((file) => file.endsWith(".html.gz"))
      .sort();
    const state = JSON.parse(await readFile(join(directory, ".reservoir.json"), "utf8")) as {
      population: number;
      slots: unknown[];
    };
    expect(afterFiles).toEqual(beforeFiles);
    expect(state).toMatchObject({ population: 20 });
    expect(state.slots).toHaveLength(20);
  });

  it("stays at twenty samples when transaction cleanup cannot unlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-replay-cleanup-"));
    directories.push(root);
    const initial = await openDailyReplayReservoir(root, "2026-07-10", "retailer-1", {
      size: 20,
      random: () => 0,
    });
    for (let index = 0; index < 20; index += 1) {
      await initial.consider(`<html>${index}</html>`, {
        kind: "observation",
        id: `observation-${index}`,
      });
    }
    const replacing = await openDailyReplayReservoir(root, "2026-07-10", "retailer-1", {
      size: 20,
      random: () => 0,
      cleanupFile: async () => { throw new Error("unlink denied"); },
    });

    await replacing.consider("<html>replacement</html>", {
      kind: "observation",
      id: "replacement-observation",
    });

    const directory = join(root, "2026-07-10", "retailer-1");
    const files = (await readdir(directory)).filter((file) => file.endsWith(".html.gz"));
    const state = JSON.parse(await readFile(join(directory, ".reservoir.json"), "utf8")) as {
      population: number;
      slots: unknown[];
    };
    expect(files).toHaveLength(20);
    expect(state).toMatchObject({ population: 21 });
    expect(state.slots).toHaveLength(20);
  });

  it("finalizes the prior day's sample manifest before opening a new day", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-replay-finalize-"));
    directories.push(root);
    const firstDay = await openDailyReplayReservoir(root, "2026-07-10", "retailer-1", {
      size: 20,
      random: () => 0,
    });
    await firstDay.consider("<html>stable</html>", {
      kind: "observation",
      id: "stable-observation",
    });

    await openDailyReplayReservoir(root, "2026-07-11", "retailer-1", {
      size: 20,
      random: () => 0,
    });

    const previous = join(root, "2026-07-10", "retailer-1");
    await expect(readFile(join(previous, ".reservoir.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    const finalized = JSON.parse(
      await readFile(join(previous, "replay-samples.json"), "utf8"),
    ) as { finalizedAt: string; slots: Array<{ evidence: { id: string } }> };
    expect(finalized.finalizedAt).toBe("2026-07-11T00:00:00.000-03:00");
    expect(finalized.slots[0]?.evidence.id).toBe("stable-observation");
  });

  it("recovers a crash after immutable manifest publication without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-replay-finalize-crash-"));
    directories.push(root);
    const firstDay = await openDailyReplayReservoir(root, "2026-07-10", "retailer-1", {
      size: 20,
      random: () => 0,
    });
    await firstDay.consider("<html>stable</html>", {
      kind: "observation",
      id: "stable-observation",
    });

    await expect(openDailyReplayReservoir(root, "2026-07-11", "retailer-1", {
      size: 20,
      random: () => 0,
      afterManifestPublish: () => {
        throw new Error("simulated crash after manifest link");
      },
    })).rejects.toThrow(/simulated crash/u);

    const previous = join(root, "2026-07-10", "retailer-1");
    const manifestPath = join(previous, "replay-samples.json");
    const statePath = join(previous, ".reservoir.json");
    const immutableBefore = await readFile(manifestPath, "utf8");
    expect(await readFile(statePath, "utf8")).toBe(immutableBefore);

    const thirdDay = await openDailyReplayReservoir(root, "2026-07-12", "retailer-1", {
      size: 20,
      random: () => 0,
    });
    await thirdDay.consider("<html>collection continues</html>", {
      kind: "observation",
      id: "third-day-observation",
    });

    expect(await readFile(manifestPath, "utf8")).toBe(immutableBefore);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const thirdState = JSON.parse(
      await readFile(join(root, "2026-07-12", "retailer-1", ".reservoir.json"), "utf8"),
    ) as { population: number; slots: Array<{ evidence: { id: string } }> };
    expect(thirdState.population).toBe(1);
    expect(thirdState.slots[0]?.evidence.id).toBe("third-day-observation");
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

    expect(summary).toMatchObject({
      planned: 1,
      attempted: 0,
      ok: 0,
      failed: 0,
      skipped: 1,
      stoppedForBlocking: false,
      status: "failed",
    });
    expect(database.prepare("SELECT status, attempted, ok, failed FROM runs").get()).toEqual({
      status: "failed",
      attempted: 0,
      ok: 0,
      failed: 0,
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

  it.each(["http-403", "http-429", "captcha", "domain-denied"] as const)(
    "stops unstarted products after persistent hard blocking category %s",
    async (category) => {
      const database = openDatabase(":memory:");
      databases.push(database);
      seedRetailer(database);
      seedStrategy(database, "extraction", extractionStrategy);
      seedProducts(database, 6);
      let calls = 0;

      const summary = await runCollection("retailer-1", {
        database,
        blockingPolicy: {
          hardFailureLimit: 2,
          transportFailureLimit: 3,
          initialDelayMs: 1,
          maxDelayMs: 2,
        },
        sleep: async () => undefined,
        concurrentMap: async (values, _concurrency, worker) => {
          const results = [];
          for (const [index, value] of values.entries()) {
            results.push(await worker(value, index));
          }
          return results;
        },
        execute: async () => {
          calls += 1;
          return {
            ok: false,
            failure: { category, message: "retailer blocked", responded: true },
          };
        },
      });

      expect(calls).toBe(2);
      expect(summary).toMatchObject({
        planned: 6,
        attempted: 2,
        ok: 0,
        failed: 2,
        skipped: 4,
        stoppedForBlocking: true,
      });
      expect(summary.attempted).toBe(summary.ok + summary.failed);
      expect(database.prepare("SELECT COUNT(*) AS n FROM run_failures").get())
        .toEqual({ n: 2 });
      expect(database.prepare("SELECT attempted, ok, failed FROM runs").get())
        .toEqual({ attempted: 2, ok: 0, failed: 2 });
      const persisted = database.prepare(
        "SELECT error_category, metadata_json FROM runs",
      ).get() as { error_category: string; metadata_json: string };
      expect(persisted.error_category).toBe(category);
      expect(JSON.parse(persisted.metadata_json)).toMatchObject({
        planned: 6,
        skipped: 4,
        stoppedForBlocking: true,
      });
    },
  );

  it("backs off exponentially within the configured bound before stopping", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 8);
    const sleeps: number[] = [];
    let clock = 10_000;

    const summary = await runCollection("retailer-1", {
      database,
      blockingPolicy: {
        hardFailureLimit: 3,
        transportFailureLimit: 3,
        initialDelayMs: 100,
        maxDelayMs: 150,
      },
      clock: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      concurrentMap: async (values, _concurrency, worker) => {
        const results = [];
        for (const [index, value] of values.entries()) {
          results.push(await worker(value, index));
        }
        return results;
      },
      execute: async () => ({
        ok: false,
        failure: {
          category: "http-403",
          message: "blocked",
          responded: true,
          statusCode: 403,
        },
      }),
    });

    expect(sleeps).toEqual([100, 150]);
    expect(summary).toMatchObject({
      planned: 8,
      attempted: 3,
      failed: 3,
      skipped: 5,
      stoppedForBlocking: true,
    });
  });

  it("defaults to three hard failures with one- and two-second backoffs", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 5);
    const sleeps: number[] = [];
    let clock = 10_000;

    const summary = await runCollection("retailer-1", {
      database,
      clock: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      concurrentMap: async (values, _concurrency, worker) => {
        const results = [];
        for (const [index, value] of values.entries()) {
          results.push(await worker(value, index));
        }
        return results;
      },
      execute: async () => ({
        ok: false,
        failure: {
          category: "http-429",
          message: "throttled",
          responded: true,
          statusCode: 429,
        },
      }),
    });

    expect(sleeps).toEqual([1_000, 2_000]);
    expect(summary).toMatchObject({
      planned: 5,
      attempted: 3,
      failed: 3,
      skipped: 2,
      stoppedForBlocking: true,
    });
  });

  it("persists blocking detection when the threshold lands on the final product", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 13);
    let calls = 0;
    let clock = 0;

    const summary = await runCollection("retailer-1", {
      database,
      clock: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      concurrentMap: async (values, _concurrency, worker) => {
        const results = [];
        for (const [index, value] of values.entries()) {
          results.push(await worker(value, index));
        }
        return results;
      },
      execute: async (_strategy, ref) => {
        calls += 1;
        if (calls > 10) {
          return {
            ok: false,
            failure: {
              category: "http-403",
              message: "final blocking burst",
              responded: true,
              statusCode: 403,
            },
          };
        }
        return {
          ok: true,
          fields: {
            title: `Fresh ${ref.externalId}`,
            brand: null,
            price: 10,
            promoPrice: null,
            unit: null,
            available: true,
          },
        };
      },
    });

    expect(summary).toMatchObject({
      planned: 13,
      attempted: 13,
      ok: 10,
      failed: 3,
      skipped: 0,
      stoppedForBlocking: true,
    });
    const row = database.prepare("SELECT metadata_json FROM runs").get() as {
      metadata_json: string;
    };
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      planned: 13,
      skipped: 0,
      stoppedForBlocking: true,
    });
  });

  it("counts alternating hard and qualified transport evidence in one access streak", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 8);
    const categories = [
      "http-403",
      "timeout",
      "http-429",
      "network",
      "captcha",
    ] as const;
    const sleeps: number[] = [];
    let clock = 0;
    let calls = 0;

    const summary = await runCollection("retailer-1", {
      database,
      blockingPolicy: {
        hardFailureLimit: 5,
        transportFailureLimit: 5,
        initialDelayMs: 10,
        maxDelayMs: 80,
      },
      clock: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      concurrentMap: async (values, _concurrency, worker) => {
        const results = [];
        for (const [index, value] of values.entries()) {
          results.push(await worker(value, index));
        }
        return results;
      },
      execute: async () => {
        const category = categories[calls] ?? "parse";
        calls += 1;
        return {
          ok: false,
          failure: {
            category,
            message: category,
            responded: category !== "timeout" && category !== "network",
          },
        };
      },
    });

    expect(calls).toBe(5);
    expect(sleeps).toEqual([10, 20, 40, 80]);
    expect(summary).toMatchObject({
      attempted: 5,
      failed: 5,
      skipped: 3,
      stoppedForBlocking: true,
    });
  });

  it("requires repeated timeout/network failures and resets on responding failures", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 7);
    const categories = ["timeout", "parse", "timeout", "network"] as const;
    let calls = 0;

    const summary = await runCollection("retailer-1", {
      database,
      blockingPolicy: {
        hardFailureLimit: 2,
        transportFailureLimit: 2,
        initialDelayMs: 1,
        maxDelayMs: 2,
      },
      sleep: async () => undefined,
      concurrentMap: async (values, _concurrency, worker) => {
        const results = [];
        for (const [index, value] of values.entries()) {
          results.push(await worker(value, index));
        }
        return results;
      },
      execute: async () => {
        const category = categories[calls] ?? "parse";
        calls += 1;
        return {
          ok: false,
          failure: {
            category,
            message: category,
            responded: category === "parse",
          },
        };
      },
    });

    expect(calls).toBe(4);
    expect(summary).toMatchObject({
      planned: 7,
      attempted: 4,
      failed: 4,
      skipped: 3,
      stoppedForBlocking: true,
    });
  });

  it("allows already in-flight work to finish without starting more products", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 9);
    let calls = 0;
    let releaseInitialWave = (): void => undefined;
    const initialWaveStarted = new Promise<void>((resolve) => {
      releaseInitialWave = resolve;
    });

    const summary = await runCollection("retailer-1", {
      database,
      concurrency: 3,
      blockingPolicy: {
        hardFailureLimit: 1,
        transportFailureLimit: 2,
        initialDelayMs: 1,
        maxDelayMs: 2,
      },
      execute: async () => {
        calls += 1;
        if (calls === 3) releaseInitialWave();
        await initialWaveStarted;
        return {
          ok: false,
          failure: {
            category: "captcha",
            message: "challenge",
            responded: true,
          },
        };
      },
    });

    expect(calls).toBe(3);
    expect(summary).toMatchObject({
      planned: 9,
      attempted: 3,
      failed: 3,
      skipped: 6,
      stoppedForBlocking: true,
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM run_failures").get())
      .toEqual({ n: 3 });
  });

  it("never treats responding parse, missing-field, or invalid-price failures as blocking", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 6);
    const categories = ["parse", "missing-fields", "invalid-price"] as const;
    let calls = 0;

    const summary = await runCollection("retailer-1", {
      database,
      blockingPolicy: {
        hardFailureLimit: 1,
        transportFailureLimit: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
      },
      execute: async () => {
        const category = categories[calls % categories.length]!;
        calls += 1;
        return {
          ok: false,
          failure: { category, message: category, responded: true },
        };
      },
    });

    expect(calls).toBe(6);
    expect(summary).toMatchObject({
      planned: 6,
      attempted: 6,
      failed: 6,
      skipped: 0,
      stoppedForBlocking: false,
    });
  });

  it("lets an already-running success reset two fast hard failures", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 6);
    let releaseSuccess = (): void => undefined;
    const successCanFinish = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    let successStarted = false;
    let announceSuccessStart = (): void => undefined;
    const successHasStarted = new Promise<void>((resolve) => {
      announceSuccessStart = resolve;
    });

    const summary = await runCollection("retailer-1", {
      database,
      sleep: async () => undefined,
      concurrentMap: async (values, _concurrency, worker) => {
        const initial = values.slice(0, 3).map((value, index) => worker(value, index));
        while (!successStarted) await new Promise((resolve) => setImmediate(resolve));
        await Promise.all(initial.slice(0, 2));
        releaseSuccess();
        await initial[2];
        const results = [...initial];
        for (let index = 3; index < values.length; index += 1) {
          results.push(worker(values[index]!, index));
        }
        return Promise.all(results);
      },
      execute: async (_strategy, ref) => {
        if (ref.externalId === "0" || ref.externalId === "1") {
          await successHasStarted;
          return {
            ok: false,
            failure: {
              category: "http-403",
              message: "fast block",
              responded: true,
              statusCode: 403,
            },
          };
        }
        if (ref.externalId === "2") {
          successStarted = true;
          announceSuccessStart();
          await successCanFinish;
        }
        return {
          ok: true,
          fields: {
            title: `Fresh ${ref.externalId}`,
            brand: null,
            price: 10,
            promoPrice: null,
            unit: null,
            available: true,
          },
        };
      },
    });

    expect(summary).toMatchObject({
      planned: 6,
      attempted: 6,
      ok: 4,
      failed: 2,
      skipped: 0,
      stoppedForBlocking: false,
    });
  });

  it("waits for real in-flight successes before committing a blocking stop", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 10);
    let started = 0;
    let releaseInitialWave = (): void => undefined;
    const initialWaveStarted = new Promise<void>((resolve) => {
      releaseInitialWave = resolve;
    });
    let releaseSuccesses = (): void => undefined;
    const successesMayFinish = new Promise<void>((resolve) => {
      releaseSuccesses = resolve;
    });

    const collection = runCollection("retailer-1", {
      database,
      concurrency: 5,
      blockingPolicy: {
        hardFailureLimit: 3,
        transportFailureLimit: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
      },
      execute: async (_strategy, ref) => {
        started += 1;
        if (started === 5) releaseInitialWave();
        if (Number(ref.externalId) < 3) {
          await initialWaveStarted;
          return {
            ok: false,
            failure: {
              category: "http-403",
              message: "fast blocker",
              responded: true,
              statusCode: 403,
            },
          };
        }
        if (Number(ref.externalId) < 5) await successesMayFinish;
        return {
          ok: true,
          fields: {
            title: `Fresh ${ref.externalId}`,
            brand: null,
            price: 10,
            promoPrice: null,
            unit: null,
            available: true,
          },
        };
      },
    });

    await waitUntil(() => started === 5, "real initial concurrency wave did not start");
    await waitUntil(() => {
      const row = database.prepare("SELECT COUNT(*) AS n FROM run_failures").get() as { n: number };
      return row.n === 3;
    }, "the three fast blocking attempts did not persist");
    await new Promise((resolve) => setImmediate(resolve));
    releaseSuccesses();
    const summary = await collection;

    expect(started).toBe(10);
    expect(summary).toMatchObject({
      planned: 10,
      attempted: 10,
      ok: 7,
      failed: 3,
      skipped: 0,
      stoppedForBlocking: false,
    });
  });

  it("rechecks an extended backoff deadline before a real concurrent start", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 6);
    let clock = 0;
    const sleepers: Array<{
      milliseconds: number;
      release: () => void;
    }> = [];
    let releaseSecondBlocker = (): void => undefined;
    const secondBlockerMayFinish = new Promise<void>((resolve) => {
      releaseSecondBlocker = resolve;
    });
    let releaseHeldSuccess = (): void => undefined;
    const heldSuccessMayFinish = new Promise<void>((resolve) => {
      releaseHeldSuccess = resolve;
    });
    let initialStarted = 0;
    let releaseInitial = (): void => undefined;
    const initialWaveStarted = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const starts = new Map<string, number>();

    const collection = runCollection("retailer-1", {
      database,
      concurrency: 3,
      blockingPolicy: {
        hardFailureLimit: 10,
        transportFailureLimit: 10,
        initialDelayMs: 100,
        maxDelayMs: 1_000,
      },
      clock: () => clock,
      sleep: (milliseconds) => new Promise<void>((resolve) => {
        let released = false;
        sleepers.push({
          milliseconds,
          release: () => {
            if (released) return;
            released = true;
            clock += milliseconds;
            resolve();
          },
        });
      }),
      execute: async (_strategy, ref) => {
        const externalId = ref.externalId ?? "";
        starts.set(externalId, clock);
        if (Number(externalId) < 3) {
          initialStarted += 1;
          if (initialStarted === 3) releaseInitial();
          await initialWaveStarted;
        }
        if (externalId === "0") {
          return {
            ok: false,
            failure: { category: "http-403", message: "first", responded: true },
          };
        }
        if (externalId === "1") {
          await secondBlockerMayFinish;
          return {
            ok: false,
            failure: { category: "http-429", message: "second", responded: true },
          };
        }
        if (externalId === "2") await heldSuccessMayFinish;
        return {
          ok: true,
          fields: {
            title: `Fresh ${externalId}`,
            brand: null,
            price: 10,
            promoPrice: null,
            unit: null,
            available: true,
          },
        };
      },
    });

    try {
      await waitUntil(() => sleepers.length === 1, "first backoff sleep was not scheduled");
      expect(sleepers[0]?.milliseconds).toBe(100);
      releaseSecondBlocker();
      await waitUntil(() => {
        const row = database.prepare("SELECT COUNT(*) AS n FROM run_failures").get() as { n: number };
        return row.n === 2;
      }, "second blocker did not extend the deadline");
      await new Promise((resolve) => setImmediate(resolve));
      sleepers[0]?.release();
      await waitUntil(
        () => sleepers.length === 2 || starts.has("3"),
        "the sleeping admission gate neither rechecked nor started",
      );

      expect(starts.has("3")).toBe(false);
      expect(sleepers[1]?.milliseconds).toBe(200);
      sleepers[1]?.release();
      await waitUntil(() => starts.has("3"), "next attempt did not start at the extended deadline");
      expect(starts.get("3")).toBe(300);
    } finally {
      releaseSecondBlocker();
      releaseHeldSuccess();
      sleepers.forEach(({ release }) => release());
      await collection.catch(() => undefined);
    }
  });

  it("cancels polite-queued products when blocking stops before they start", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    seedProducts(database, 6);
    const sleepCalls: number[] = [];
    let clock = 0;
    let releasePoliteWait = (): void => undefined;
    const politeWaitMayFinish = new Promise<void>((resolve) => {
      releasePoliteWait = resolve;
    });
    const executed: string[] = [];

    const collection = runCollection("retailer-1", {
      database,
      concurrency: 3,
      politeDelayMs: { min: 100, max: 100 },
      blockingPolicy: {
        hardFailureLimit: 1,
        transportFailureLimit: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
      },
      clock: () => clock,
      sleep: async (milliseconds) => {
        sleepCalls.push(milliseconds);
        await politeWaitMayFinish;
        clock += milliseconds;
      },
      execute: async (_strategy, ref) => {
        const externalId = ref.externalId ?? "";
        executed.push(externalId);
        if (externalId === "0") {
          await waitUntil(() => sleepCalls.length > 0, "polite queue did not begin waiting");
          return {
            ok: false,
            failure: { category: "captcha", message: "stop", responded: true },
          };
        }
        return {
          ok: true,
          fields: {
            title: `Fresh ${externalId}`,
            brand: null,
            price: 10,
            promoPrice: null,
            unit: null,
            available: true,
          },
        };
      },
    });

    await waitUntil(() => sleepCalls.length === 1, "polite wait was not scheduled");
    await waitUntil(() => {
      const row = database.prepare("SELECT COUNT(*) AS n FROM run_failures").get() as { n: number };
      return row.n === 1;
    }, "blocking result did not persist while products were queued");
    await new Promise((resolve) => setImmediate(resolve));
    releasePoliteWait();
    const summary = await collection;

    expect(executed).toEqual(["0"]);
    expect(sleepCalls).toEqual([100]);
    expect(summary).toMatchObject({
      planned: 6,
      attempted: 1,
      failed: 1,
      skipped: 5,
      stoppedForBlocking: true,
    });
  });
});
