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
});
