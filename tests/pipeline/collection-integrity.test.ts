import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classifyNewProducts } from "../../src/classify/classify.js";
import { decideFoodAtHomeScope } from "../../src/catalog/scope.js";
import { openDatabase } from "../../src/db/database.js";
import {
  createRun,
  finalizeDiscoveryRun,
  listCollectionProducts,
  upsertDiscoveredProduct,
} from "../../src/db/repositories.js";
import { runCollection } from "../../src/pipeline/collect.js";
import { runDiscovery } from "../../src/pipeline/discover.js";
import {
  discoveryStrategy,
  extractionStrategy,
  seedRetailer,
  seedStrategy,
} from "./helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const directories: string[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function databaseWithStrategies(): ReturnType<typeof openDatabase> {
  const database = openDatabase(":memory:");
  databases.push(database);
  seedRetailer(database);
  seedStrategy(database, "discovery", discoveryStrategy);
  seedStrategy(database, "extraction", extractionStrategy);
  return database;
}

function seedProducts(
  database: ReturnType<typeof openDatabase>,
  count: number,
): void {
  const statement = database.prepare(`
    INSERT INTO products
      (id, retailer_id, canonical_url, retailer_product_id, title,
       source_category, first_seen, last_seen)
    VALUES (?, 'retailer-1', ?, ?, ?, 'Mercearia',
            '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `);
  const insert = database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(4, "0");
      statement.run(
        `p-${suffix}`,
        `https://shop.test/mercearia/produto-${suffix}/p`,
        suffix,
        `produto ${suffix}`,
      );
    }
  });
  insert.immediate();
}

function fillStageRequestAdmissions(
  database: ReturnType<typeof openDatabase>,
  input: {
    runId: string;
    stage: "discover" | "collect";
    day: string;
    count: number;
  },
): void {
  database.prepare(`
    WITH RECURSIVE ordinals(ordinal) AS (
      VALUES (1)
      UNION ALL SELECT ordinal + 1 FROM ordinals WHERE ordinal < ?
    )
    INSERT INTO request_admissions
      (id, run_id, retailer_id, collection_day, stage, stage_ordinal, admitted_at)
    SELECT printf('%s-%04d', ?, ordinal), ?, 'retailer-1', ?, ?, ordinal,
           ? || 'T03:00:00.000Z'
    FROM ordinals
  `).run(
    input.count,
    `${input.runId}-request`,
    input.runId,
    input.day,
    input.stage,
    input.day,
  );
}

describe("collection integrity", () => {
  it("persists an audited 2,500-reference catalog with fail-closed scope evidence", async () => {
    const database = databaseWithStrategies();

    const summary = await runDiscovery("retailer-1", {
      database,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* (_strategy, context) {
        for (let index = 0; index < 2_500; index += 1) {
          const food = index < 2_400;
          yield {
            canonicalUrl: food
              ? `https://shop.test/mercearia/arroz-tipo-1-${index}/p`
              : `https://shop.test/limpeza/esponja-${index}/p`,
            externalId: String(index),
            sourceCategory: food ? "/Mercearia/Alimentos Básicos/" : "/Limpeza/Cozinha/",
          };
        }
        context.reportCompletion?.({ complete: true, reason: "source_exhausted" });
      },
    });

    expect(summary).toMatchObject({
      attempted: 2_500,
      ok: 2_500,
      failed: 0,
      inScope: 2_400,
      outOfScope: 100,
      snapshotComplete: true,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM product_scope_decisions",
    ).get()).toEqual({ count: 2_500 });
    expect(database.prepare(`
      SELECT
        SUM(in_scope = 1) AS inScope,
        SUM(in_scope = 0) AS outOfScope,
        SUM(json_valid(evidence_json)) AS validEvidence
      FROM product_scope_decisions
    `).get()).toEqual({ inScope: 2_400, outOfScope: 100, validEvidence: 2_500 });
    expect(database.prepare(`
      SELECT complete, discovered, in_scope AS inScope,
             out_of_scope AS outOfScope, disappeared
      FROM catalog_snapshots
    `).get()).toEqual({
      complete: 1,
      discovered: 2_500,
      inScope: 2_400,
      outOfScope: 100,
      disappeared: 0,
    });
  }, 20_000);

  it("keeps discovery and collection attempt budgets independent", async () => {
    const database = databaseWithStrategies();
    seedProducts(database, 2);
    database.prepare(`
      INSERT INTO runs
        (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
         status, attempted, ok, failed, started_at)
      VALUES
        ('discovery-cap', 'retailer-1', 'discover', '2026-07-10',
         'retailer-1-discovery-v1', 1, 'running', 0, 0, 0,
         '2026-07-10T03:00:00.000Z')
    `).run();
    fillStageRequestAdmissions(database, {
      runId: "discovery-cap",
      stage: "discover",
      day: "2026-07-10",
      count: 2_000,
    });

    const collection = await runCollection("retailer-1", {
      database,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async () => ({
        ok: false,
        failure: { category: "parse", message: "fixture", responded: true },
      }),
    });
    expect(collection.attempted).toBe(2);

    database.prepare(`
      INSERT INTO runs
        (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
         status, attempted, ok, failed, started_at)
      VALUES
        ('collection-cap', 'retailer-1', 'collect', '2026-07-11',
         'retailer-1-extraction-v1', 1, 'running', 0, 0, 0,
         '2026-07-11T03:00:00.000Z')
    `).run();
    fillStageRequestAdmissions(database, {
      runId: "collection-cap",
      stage: "collect",
      day: "2026-07-11",
      count: 2_000,
    });
    let executions = 0;
    const discovery = await runDiscovery("retailer-1", {
      database,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      limit: 1,
      execute: async function* (_strategy, context) {
        await context.beforeRequest?.();
        executions += 1;
        yield {
          canonicalUrl: "https://shop.test/mercearia/arroz-novo/p",
          externalId: "new",
          sourceCategory: "Mercearia",
        };
      },
    });
    expect(discovery.attempted).toBe(1);
    expect(executions).toBe(1);
  });

  it("rotates never-attempted products first, then the oldest attempted cohort", () => {
    const database = databaseWithStrategies();
    seedProducts(database, 2_501);
    database.prepare(`
      UPDATE products
      SET last_observed_at = '2026-07-10T00:00:00.000Z',
          last_collection_attempt_at = '2026-07-10T00:00:00.000Z'
      WHERE id < 'p-2000'
    `).run();

    const neverAttempted = listCollectionProducts(database, "retailer-1", 501);
    expect(neverAttempted).toHaveLength(501);
    expect(neverAttempted[0]?.id).toBe("p-2000");
    expect(neverAttempted.at(-1)?.id).toBe("p-2500");

    database.prepare(`
      UPDATE products
      SET last_collection_attempt_at = '2026-07-11T00:00:00.000Z'
      WHERE last_collection_attempt_at IS NULL
    `).run();
    expect(listCollectionProducts(database, "retailer-1", 10).map(({ id }) => id))
      .toEqual(Array.from({ length: 10 }, (_, index) =>
        `p-${String(index).padStart(4, "0")}`));

    database.prepare(`
      UPDATE products
      SET last_observed_at = '2026-07-01T00:00:00.000Z',
          last_collection_attempt_at = '2026-07-12T00:00:00.000Z'
      WHERE id = 'p-0000'
    `).run();
    expect(listCollectionProducts(database, "retailer-1", 2).map(({ id }) => id))
      .toEqual(["p-0001", "p-0002"]);
  });

  it("freezes last_seen and deactivates disappearances only after verified completion", async () => {
    const database = databaseWithStrategies();
    database.prepare(`
      INSERT INTO products
        (id, retailer_id, canonical_url, title, source_category,
         first_seen, last_seen)
      VALUES
        ('old', 'retailer-1', 'https://shop.test/mercearia/old/p', 'old',
         'Mercearia', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `).run();
    const current = {
      canonicalUrl: "https://shop.test/mercearia/current/p",
      externalId: "current",
      sourceCategory: "Mercearia",
    };

    const incomplete = await runDiscovery("retailer-1", {
      database,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* () { yield current; },
    });
    expect(incomplete.snapshotComplete).toBe(false);
    expect(database.prepare("SELECT active FROM products WHERE id = 'old'").get())
      .toEqual({ active: 1 });

    const complete = await runDiscovery("retailer-1", {
      database,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      execute: async function* (_strategy, context) {
        yield current;
        context.reportCompletion?.({ complete: true, reason: "source_exhausted" });
      },
    });
    expect(complete).toMatchObject({ snapshotComplete: true, disappeared: 1 });
    expect(database.prepare(
      "SELECT active, last_seen AS lastSeen FROM products WHERE id = 'old'",
    ).get()).toEqual({ active: 0, lastSeen: "2026-07-01T00:00:00.000Z" });
    expect(database.prepare(`
      SELECT complete, disappeared FROM catalog_snapshots ORDER BY completed_at
    `).all()).toEqual([
      { complete: 0, disappeared: 0 },
      { complete: 1, disappeared: 1 },
    ]);
  });

  it("downgrades empty and catastrophic-shrink completion claims without deactivation", async () => {
    const emptyDatabase = databaseWithStrategies();
    seedProducts(emptyDatabase, 1);
    const empty = await runDiscovery("retailer-1", {
      database: emptyDatabase,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* (_strategy, context) {
        context.reportCompletion?.({ complete: true, reason: "source_exhausted" });
      },
    });
    expect(empty).toMatchObject({ snapshotComplete: false, disappeared: 0 });
    expect(emptyDatabase.prepare(
      "SELECT active FROM products WHERE id = 'p-0000'",
    ).get()).toEqual({ active: 1 });
    expect(emptyDatabase.prepare(`
      SELECT complete, completion_reason AS reason, disappeared
      FROM catalog_snapshots
    `).get()).toEqual({
      complete: 0,
      reason: "empty_snapshot_guard",
      disappeared: 0,
    });

    const shrinkDatabase = databaseWithStrategies();
    seedProducts(shrinkDatabase, 100);
    const shrink = await runDiscovery("retailer-1", {
      database: shrinkDatabase,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* (_strategy, context) {
        for (let index = 0; index < 10; index += 1) {
          const suffix = String(index).padStart(4, "0");
          yield {
            canonicalUrl: `https://shop.test/mercearia/produto-${suffix}/p`,
            externalId: suffix,
            sourceCategory: "Mercearia",
          };
        }
        context.reportCompletion?.({ complete: true, reason: "source_exhausted" });
      },
    });
    expect(shrink).toMatchObject({
      attempted: 10,
      ok: 10,
      snapshotComplete: false,
      disappeared: 0,
    });
    expect(shrinkDatabase.prepare(
      "SELECT COUNT(*) AS count FROM products WHERE active = 1",
    ).get()).toEqual({ count: 100 });
    expect(shrinkDatabase.prepare(`
      SELECT complete, completion_reason AS reason, disappeared
      FROM catalog_snapshots
    `).get()).toEqual({
      complete: 0,
      reason: "catastrophic_shrink_guard",
      disappeared: 0,
    });
  });

  it("atomically rolls back disappearance when terminal run finalization fails", () => {
    const database = databaseWithStrategies();
    seedProducts(database, 1);
    const runId = "atomic-discovery-finalization";
    createRun(database, {
      id: runId,
      retailerId: "retailer-1",
      stage: "discover",
      collectionDay: "2026-07-10",
      strategyId: "retailer-1-discovery-v1",
      strategyVersion: 1,
      startedAt: "2026-07-10T12:00:00.000Z",
    });
    const current = {
      canonicalUrl: "https://shop.test/mercearia/current/p",
      externalId: "current",
      sourceCategory: "Mercearia",
    };
    upsertDiscoveredProduct(
      database,
      "retailer-1",
      current,
      "2026-07-10T12:00:10.000Z",
      { runId, scope: decideFoodAtHomeScope(current) },
    );
    database.exec(`
      CREATE TRIGGER fail_atomic_run_finalization
      BEFORE UPDATE OF status ON runs
      WHEN NEW.id = 'atomic-discovery-finalization'
      BEGIN
        SELECT RAISE(ABORT, 'injected finalization failure');
      END;
    `);

    expect(() => finalizeDiscoveryRun(database, {
      snapshot: {
        runId,
        retailerId: "retailer-1",
        complete: true,
        completionReason: "source_exhausted",
        discovered: 1,
        inScope: 1,
        outOfScope: 0,
        completedAt: "2026-07-10T12:01:00.000Z",
      },
      counters: { attempted: 1, ok: 1, failed: 0 },
      status: "completed",
      finishedAt: "2026-07-10T12:01:00.000Z",
    })).toThrow(/injected finalization failure/iu);
    expect(database.prepare(
      "SELECT active FROM products WHERE id = 'p-0000'",
    ).get()).toEqual({ active: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM catalog_snapshots WHERE run_id = ?",
    ).get(runId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status, attempted FROM runs WHERE id = ?",
    ).get(runId)).toEqual({ status: "running", attempted: 0 });
  });

  it("never classifies numeric discovery IDs and unlocks titles only after observation", async () => {
    const database = databaseWithStrategies();
    const discoveredAt = "2026-07-10T12:00:00.000Z";
    await runDiscovery("retailer-1", {
      database,
      now: () => new Date(discoveredAt),
      execute: async function* () {
        yield {
          canonicalUrl: "https://shop.test/mercearia/cafe-torrado-premium/p",
          externalId: "9001",
          sourceCategory: "Mercearia",
        };
        yield {
          canonicalUrl: "https://shop.test/produto/9002/p",
          externalId: "9002",
          sourceCategory: "Mercearia",
        };
      },
    });
    const discovered = database.prepare(`
      SELECT retailer_product_id AS externalId, title, descriptive_title AS descriptive
      FROM products ORDER BY retailer_product_id
    `).all();
    expect(discovered).toEqual([
      { externalId: "9001", title: "cafe torrado premium", descriptive: 0 },
      {
        externalId: "9002",
        title: "Produto aguardando observação descritiva",
        descriptive: 0,
      },
    ]);
    database.prepare(`
      INSERT INTO ipca_items
        (id, code, name, weight, weight_period, source_url, citation)
      VALUES ('ipca-cafe', '1103', 'Café', 1, '2019-12', 'https://ibge.test', 'IBGE')
    `).run();
    expect(await classifyNewProducts({
      version: 1,
      confidenceThreshold: 0.8,
      dryRun: true,
    }, { database })).toMatchObject({ eligible: 0 });

    const before = database.prepare(`
      SELECT id, last_seen AS lastSeen FROM products ORDER BY id
    `).all();
    await runCollection("retailer-1", {
      database,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      execute: async (_strategy, ref) => ({
        ok: true,
        fields: {
          title: ref.externalId === "9001" ? "Café Torrado Premium" : "Arroz Tipo 1",
          brand: "Marca",
          price: 10,
          promoPrice: 9,
          unit: "500 g",
          available: true,
        },
      }),
    });
    const observed = database.prepare(`
      SELECT id, title, descriptive_title AS descriptive,
             last_seen AS lastSeen, last_observed_at AS lastObserved
      FROM products ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    expect(observed.every(({ descriptive }) => descriptive === 1)).toBe(true);
    expect(observed.map(({ id, lastSeen }) => ({ id, lastSeen }))).toEqual(before);
    expect(observed.every(({ lastObserved }) =>
      lastObserved === "2026-07-11T12:00:00.000Z")).toBe(true);
    expect(await classifyNewProducts({
      version: 1,
      confidenceThreshold: 0.8,
      dryRun: true,
    }, { database })).toMatchObject({ eligible: 2 });
  });

  it("rejects a numeric extraction title instead of unlocking classification", async () => {
    const database = databaseWithStrategies();
    seedProducts(database, 1);
    const summary = await runCollection("retailer-1", {
      database,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      execute: async () => ({
        ok: true,
        fields: {
          title: "9001",
          brand: null,
          price: 10,
          promoPrice: null,
          unit: null,
          available: true,
        },
      }),
    });

    expect(summary).toMatchObject({ attempted: 1, ok: 0, failed: 1 });
    expect(database.prepare(`
      SELECT title, descriptive_title AS descriptive
      FROM products WHERE id = 'p-0000'
    `).get()).toEqual({ title: "produto 0000", descriptive: 0 });
    expect(database.prepare(
      "SELECT category FROM run_failures WHERE run_id = ?",
    ).get(summary.id)).toEqual({ category: "unknown" });
  });

  it("writes sanitized private per-run logs without replay bodies or URLs", async () => {
    const database = databaseWithStrategies();
    const logDirectory = await mkdtemp(join(tmpdir(), "precos-run-logs-"));
    const replayDirectory = await mkdtemp(join(tmpdir(), "precos-run-replay-"));
    directories.push(logDirectory);
    directories.push(replayDirectory);
    await runDiscovery("retailer-1", {
      database,
      id: () => "discovery-log-run",
      logDirectory,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* () {
        yield {
          canonicalUrl: "https://shop.test/mercearia/private-product-url/p",
          externalId: "private-id",
          sourceCategory: "Mercearia token=category-secret",
        };
      },
    });
    await runCollection("retailer-1", {
      database,
      id: () => "collection-log-run",
      logDirectory,
      rawHtmlRoot: replayDirectory,
      now: () => new Date("2026-07-10T13:00:00.000Z"),
      execute: async () => ({
        ok: true,
        fields: {
          title: "Produto",
          brand: null,
          price: 1,
          promoPrice: null,
          unit: null,
          available: true,
        },
        html: "<html>private-replay-body</html>",
      }),
    });

    const files = (await readdir(logDirectory)).sort();
    expect(files).toHaveLength(2);
    const texts = await Promise.all(files.map((file) => readFile(join(logDirectory, file), "utf8")));
    const serialized = texts.join("\n");
    expect(serialized).not.toContain("category-secret");
    expect(serialized).not.toContain("private-replay-body");
    expect(serialized).not.toContain("private-product-url");
    expect(serialized).toContain("[REDACTED]");
    expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
    for (const file of files) {
      expect((await stat(join(logDirectory, file))).mode & 0o777).toBe(0o600);
      for (const line of (await readFile(join(logDirectory, file), "utf8")).trim().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("fails closed before network work when mandatory run logging is unavailable", async () => {
    const collectionDatabase = databaseWithStrategies();
    seedProducts(collectionDatabase, 1);
    let collectionExecutions = 0;
    const collection = await runCollection("retailer-1", {
      database: collectionDatabase,
      logDirectory: "/dev/null",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async () => {
        collectionExecutions += 1;
        throw new Error("network must not run");
      },
    });
    expect(collectionExecutions).toBe(0);
    expect(collection).toMatchObject({ status: "failed", attempted: 0, ok: 0, failed: 0 });
    expect(collectionDatabase.prepare(`
      SELECT status, error_category AS category
      FROM runs WHERE id = ?
    `).get(collection.id)).toEqual({ status: "failed", category: "unknown" });
    expect(collectionDatabase.prepare(
      "SELECT COUNT(*) AS count FROM request_admissions",
    ).get()).toEqual({ count: 0 });

    const discoveryDatabase = databaseWithStrategies();
    let discoveryExecutions = 0;
    const discovery = await runDiscovery("retailer-1", {
      database: discoveryDatabase,
      logDirectory: "/dev/null",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      execute: async function* () {
        discoveryExecutions += 1;
      },
    });
    expect(discoveryExecutions).toBe(0);
    expect(discovery).toMatchObject({
      status: "failed",
      attempted: 0,
      ok: 0,
      failed: 0,
      snapshotComplete: false,
    });
    expect(discoveryDatabase.prepare(`
      SELECT status, error_category AS category
      FROM runs WHERE id = ?
    `).get(discovery.id)).toEqual({ status: "failed", category: "unknown" });
    expect(discoveryDatabase.prepare(
      "SELECT COUNT(*) AS count FROM request_admissions",
    ).get()).toEqual({ count: 0 });
    expect(discoveryDatabase.prepare(
      "SELECT COUNT(*) AS count FROM discovery_reference_admissions",
    ).get()).toEqual({ count: 0 });
  });
});
