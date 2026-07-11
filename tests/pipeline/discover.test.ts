import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { DiscoveryFailureError } from "../../src/discovery/failure.js";
import { runDiscovery } from "../../src/pipeline/discover.js";
import { upsertDiscoveredProduct } from "../../src/db/repositories.js";
import type { ProductRef } from "../../src/strategies/types.js";
import { discoveryStrategy, seedRetailer, seedStrategy } from "./helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function fillRequestAdmissions(
  database: ReturnType<typeof openDatabase>,
  runId: string,
  count: number,
): void {
  database.prepare(`
    WITH RECURSIVE ordinals(ordinal) AS (
      VALUES (1)
      UNION ALL SELECT ordinal + 1 FROM ordinals WHERE ordinal < ?
    )
    INSERT INTO request_admissions
      (id, run_id, retailer_id, collection_day, stage, stage_ordinal, admitted_at)
    SELECT printf('%s-request-%04d', ?, ordinal), ?, 'retailer-1',
           '2026-07-10', 'discover', ordinal, '2026-07-10T03:00:00.000Z'
    FROM ordinals
  `).run(count, runId, runId);
}

function fillDiscoveryReferenceAdmissions(
  database: ReturnType<typeof openDatabase>,
  runId: string,
  count: number,
): void {
  database.prepare(`
    WITH RECURSIVE ordinals(ordinal) AS (
      VALUES (1)
      UNION ALL SELECT ordinal + 1 FROM ordinals WHERE ordinal < ?
    )
    INSERT INTO discovery_reference_admissions
      (id, run_id, retailer_id, collection_day, day_ordinal,
       canonical_url, admitted_at)
    SELECT printf('%s-reference-%04d', ?, ordinal), ?, 'retailer-1',
           '2026-07-10', ordinal, printf('https://shop.test/prior/%d', ordinal),
           '2026-07-10T03:00:00.000Z'
    FROM ordinals
  `).run(count, runId, runId);
}

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
    expect(summary).toMatchObject({ attempted: 2, ok: 2, failed: 0, successRate: 1 });
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

  it("does no network/executor work and writes no evidence in dry-run mode", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);

    let executions = 0;
    const summary = await runDiscovery("retailer-1", {
      database,
      dryRun: true,
      execute: async function* () {
        executions += 1;
        yield { canonicalUrl: "https://shop.test/a", externalId: null, sourceCategory: null };
      },
    });

    expect(executions).toBe(0);
    expect(summary).toMatchObject({ attempted: 0, ok: 0, failed: 0, dryRun: true });
    expect(database.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM run_failures").get()).toEqual({ n: 0 });
  });

  it("runs an immutable inactive candidate while preserving the live catalog", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    const liveId = seedStrategy(database, "discovery", discoveryStrategy);
    upsertDiscoveredProduct(
      database,
      "retailer-1",
      { canonicalUrl: "https://shop.test/live", externalId: "live", sourceCategory: "food" },
      "2026-07-10T05:00:00.000Z",
    );
    const candidate = {
      id: "retailer-1-discovery-v2",
      retailerId: "retailer-1",
      purpose: "discovery" as const,
      version: 2,
      strategy: discoveryStrategy,
    };
    database.prepare(
      `INSERT INTO strategies
       (id, retailer_id, purpose, tier, version, strategy_json, provenance,
        validation_sample_size, validation_successes, validation_rate, active)
       VALUES (?, 'retailer-1', 'discovery', 1, 2, ?, 'candidate', 0, 0, NULL, 0)`,
    ).run(candidate.id, JSON.stringify(candidate.strategy));

    const summary = await runDiscovery("retailer-1", {
      database,
      strategyOverride: candidate,
      preserveCatalog: true,
      execute: async function* (_strategy, context) {
        yield {
          canonicalUrl: "https://shop.test/candidate",
          externalId: "candidate",
          sourceCategory: "food",
        };
        context.reportCompletion?.({ complete: true, reason: "source_exhausted" });
      },
      now: () => new Date("2026-07-10T06:00:00.000Z"),
    });

    expect(summary).toMatchObject({ ok: 1, snapshotComplete: false, disappeared: 0 });
    expect(database.prepare(
      "SELECT strategy_id AS strategyId FROM runs WHERE id = ?",
    ).get(summary.id)).toEqual({ strategyId: candidate.id });
    expect(database.prepare(
      "SELECT completion_reason AS reason FROM catalog_snapshots WHERE run_id = ?",
    ).get(summary.id)).toEqual({ reason: "candidate_validation_preflight" });
    expect(database.prepare(
      "SELECT active FROM products WHERE canonical_url = 'https://shop.test/live'",
    ).get()).toEqual({ active: 1 });
    expect(database.prepare("SELECT active FROM strategies WHERE id = ?").get(liveId))
      .toEqual({ active: 1 });
  });

  it("applies the durable 3,000-reference cap across same-day discovery runs", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    const strategyId = seedStrategy(database, "discovery", discoveryStrategy);
    database.prepare(
      `INSERT INTO runs
         (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
          status, attempted, ok, failed, started_at)
       VALUES
         ('prior', 'retailer-1', 'discover', '2026-07-10', ?, 1,
          'running', 0, 0, 0, '2026-07-10T03:00:00.000Z')`,
    ).run(strategyId);
    fillDiscoveryReferenceAdmissions(database, "prior", 2_999);
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
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM discovery_reference_admissions",
    ).get()).toEqual({ count: 3_000 });
  });

  it("aggregates concurrent discovery runs under the durable 3,000-reference cap", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);
    const discover = (label: string) => runDiscovery("retailer-1", {
      database,
      id: () => `concurrent-discovery-${label}`,
      limit: 3_000,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* () {
        for (let index = 0; index < 3_000; index += 1) {
          yield {
            canonicalUrl: `https://shop.test/${label}/${index}`,
            externalId: `${label}-${index}`,
            sourceCategory: "Mercearia",
          };
        }
      },
    });

    const summaries = await Promise.all([discover("a"), discover("b")]);

    expect(summaries.reduce((sum, summary) => sum + summary.attempted, 0)).toBe(3_000);
    expect(database.prepare(`
      SELECT COUNT(*) AS count, COUNT(DISTINCT day_ordinal) AS ordinals
      FROM discovery_reference_admissions
    `).get()).toEqual({ count: 3_000, ordinals: 3_000 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM products").get())
      .toEqual({ count: 3_000 });
  }, 30_000);

  it("stops cleanly when the durable request budget is reached mid-source", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    const strategyId = seedStrategy(database, "discovery", discoveryStrategy);
    database.prepare(`
      INSERT INTO runs
        (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
         status, attempted, ok, failed, started_at)
      VALUES ('prior-requests', 'retailer-1', 'discover', '2026-07-10', ?, 1,
              'running', 0, 0, 0, '2026-07-10T03:00:00.000Z')
    `).run(strategyId);
    fillRequestAdmissions(database, "prior-requests", 1_999);
    let yielded = 0;

    const summary = await runDiscovery("retailer-1", {
      database,
      limit: 10,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* (_strategy, context) {
        for (let index = 0; index < 10; index += 1) {
          await context.beforeRequest?.();
          yielded += 1;
          yield {
            canonicalUrl: `https://shop.test/request-${index}`,
            externalId: String(index),
            sourceCategory: null,
          };
        }
      },
    });

    expect(yielded).toBe(1);
    expect(summary).toMatchObject({ attempted: 1, ok: 1, failed: 0 });
    expect(database.prepare(
      "SELECT completion_reason AS reason FROM catalog_snapshots WHERE run_id = ?",
    ).get(summary.id)).toEqual({ reason: "request_cap_reached" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM request_admissions WHERE stage = 'discover'",
    ).get()).toEqual({ count: 2_000 });
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

  it("performs no executor or robots traffic after the discovery cap is exhausted", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    const strategyId = seedStrategy(database, "discovery", discoveryStrategy);
    database.prepare(
      `INSERT INTO runs
         (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
          status, attempted, ok, failed, started_at)
       VALUES
         ('prior-cap', 'retailer-1', 'discover', '2026-07-10', ?, 1,
          'running', 0, 0, 0, '2026-07-10T03:00:00.000Z')`,
    ).run(strategyId);
    fillDiscoveryReferenceAdmissions(database, "prior-cap", 3_000);
    let executions = 0;

    const summary = await runDiscovery("retailer-1", {
      database,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* () {
        executions += 1;
        yield { canonicalUrl: "https://shop.test/a", externalId: null, sourceCategory: null };
      },
    });

    expect(executions).toBe(0);
    expect(summary).toMatchObject({ attempted: 0, ok: 0, failed: 0, status: "completed" });
    expect(database.prepare(
      "SELECT completion_reason AS reason FROM catalog_snapshots WHERE run_id = ?",
    ).get(summary.id)).toEqual({ reason: "product_cap_reached" });
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

  it("preserves typed page failure category and terminal failed evidence", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);

    const summary = await runDiscovery("retailer-1", {
      database,
      execute: async function* () {
        throw new DiscoveryFailureError({
          category: "http-429",
          message: "Discovery request returned HTTP 429",
          responded: true,
          statusCode: 429,
        });
      },
    });

    expect(summary).toMatchObject({ attempted: 0, ok: 0, failed: 0, status: "failed" });
    expect(database.prepare(
      "SELECT category, http_status FROM run_failures",
    ).get()).toEqual({ category: "http-429", http_status: 429 });
    expect(database.prepare(
      "SELECT status, error_category FROM runs",
    ).get()).toEqual({ status: "failed", error_category: "http-429" });
  });

  it("establishes robots and applies configured delay before sitemap requests", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);
    const requests: string[] = [];
    const sleeps: number[] = [];
    let clock = 1_000;

    const summary = await runDiscovery("retailer-1", {
      database,
      politeDelayMs: { min: 750, max: 750 },
      clock: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      executionContext: {
        fetch: async (input) => {
          const url = String(input);
          requests.push(url);
          return new Response(url.endsWith("/robots.txt")
            ? "User-agent: *\nDisallow:\n"
            : "<urlset><url><loc>https://shop.test/a</loc></url></urlset>");
        },
      },
    });

    expect(summary).toMatchObject({ attempted: 1, ok: 1, failed: 0 });
    expect(requests).toEqual([
      "https://shop.test/robots.txt",
      "https://shop.test/sitemap.xml",
    ]);
    expect(sleeps).toEqual([750]);
  });

  it("fails closed with categorized evidence when robots cannot be established", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);

    const summary = await runDiscovery("retailer-1", {
      database,
      executionContext: {
        fetch: async () => new Response("unavailable", { status: 503 }),
      },
    });

    expect(summary).toMatchObject({ attempted: 0, ok: 0, failed: 0, status: "failed" });
    expect(database.prepare("SELECT category, http_status FROM run_failures").get())
      .toEqual({ category: "unknown", http_status: 503 });
  });
});
