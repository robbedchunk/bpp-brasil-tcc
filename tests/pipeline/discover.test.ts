import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { runDiscovery } from "../../src/pipeline/discover.js";
import type { ProductRef } from "../../src/strategies/types.js";
import { discoveryStrategy, seedRetailer, seedStrategy } from "./helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("discovery pipeline", () => {
  it("creates the run first and preserves a rejected page as unknown evidence", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);
    let runExistedDuringExecution = false;

    async function* execute(): AsyncGenerator<ProductRef> {
      runExistedDuringExecution =
        (database.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n === 1;
      yield { canonicalUrl: "https://shop.test/a", externalId: "a", sourceCategory: "food" };
      yield { canonicalUrl: "https://shop.test/b", externalId: "b", sourceCategory: "food" };
      throw new Error("page rejected");
    }

    const summary = await runDiscovery("retailer-1", {
      database,
      execute,
      now: () => new Date("2026-07-10T06:00:00.000Z"),
    });

    expect(runExistedDuringExecution).toBe(true);
    expect(summary).toMatchObject({ attempted: 3, ok: 2, failed: 1, successRate: 2 / 3 });
    expect(summary.attempted).toBe(summary.ok + summary.failed);
    expect(database.prepare("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 2 });
    expect(database.prepare("SELECT category, message FROM run_failures").get()).toEqual({
      category: "unknown",
      message: "page rejected",
    });
    expect(database.prepare("SELECT status, finished_at FROM runs").get()).toMatchObject({
      status: "partial",
      finished_at: "2026-07-10T06:00:00.000Z",
    });
  });

  it("does not write products, runs, or failures in dry-run mode", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);

    const summary = await runDiscovery("retailer-1", {
      database,
      dryRun: true,
      execute: async function* () {
        yield { canonicalUrl: "https://shop.test/a", externalId: null, sourceCategory: null };
      },
    });

    expect(summary).toMatchObject({ attempted: 1, ok: 1, failed: 0, dryRun: true });
    expect(database.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 0 });
  });

  it("applies the 2,000 cap cumulatively across same-day discovery runs", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    const strategyId = seedStrategy(database, "discovery", discoveryStrategy);
    database.prepare(
      `INSERT INTO runs
         (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
          status, attempted, ok, failed, started_at, finished_at)
       VALUES
         ('prior', 'retailer-1', 'discover', '2026-07-10', ?, 1,
          'failed', 1999, 0, 1999, '2026-07-10T03:00:00.000Z',
          '2026-07-10T03:10:00.000Z')`,
    ).run(strategyId);
    let yielded = 0;

    const summary = await runDiscovery("retailer-1", {
      database,
      limit: 100,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* () {
        for (let index = 0; index < 10; index += 1) {
          yielded += 1;
          yield {
            canonicalUrl: `https://shop.test/${index}`,
            externalId: String(index),
            sourceCategory: null,
          };
        }
      },
    });

    expect(yielded).toBe(1);
    expect(summary.attempted).toBe(1);
  });

  it("does not exceed the cap when closing a limited iterator throws", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);

    const summary = await runDiscovery("retailer-1", {
      database,
      limit: 1,
      execute: async function* () {
        try {
          yield { canonicalUrl: "https://shop.test/1", externalId: "1", sourceCategory: null };
          yield { canonicalUrl: "https://shop.test/2", externalId: "2", sourceCategory: null };
        } finally {
          throw new Error("iterator cleanup failed");
        }
      },
    });

    expect(summary).toMatchObject({ attempted: 1, ok: 1, failed: 0 });
  });

  it("does not double-count a product when failure-evidence persistence also fails", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);
    database.exec(`
      CREATE TRIGGER reject_test_failures
      BEFORE INSERT ON run_failures
      BEGIN SELECT RAISE(ABORT, 'failure sink unavailable'); END
    `);

    const summary = await runDiscovery("retailer-1", {
      database,
      execute: async function* () {
        yield {
          canonicalUrl: null as unknown as string,
          externalId: "broken",
          sourceCategory: null,
        };
      },
    });

    expect(summary).toMatchObject({ attempted: 1, ok: 0, failed: 1 });
    expect(database.prepare("SELECT attempted, ok, failed, status FROM runs").get()).toEqual({
      attempted: 1,
      ok: 0,
      failed: 1,
      status: "failed",
    });
  });
});
