import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { recordCatalogSnapshot } from "../../src/db/repositories.js";
import {
  discoveryStrategy,
  extractionStrategy,
  seedRetailer,
  seedStrategy,
} from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function evidenceDatabase(): ReturnType<typeof openDatabase> {
  const database = openDatabase(":memory:");
  databases.push(database);
  for (const retailerId of ["retailer-a", "retailer-b"]) {
    seedRetailer(database, retailerId);
    seedStrategy(database, "discovery", discoveryStrategy, retailerId);
    seedStrategy(database, "extraction", extractionStrategy, retailerId);
  }
  database.exec(`
    INSERT INTO products
      (id, retailer_id, canonical_url, title, first_seen, last_seen)
    VALUES
      ('product-a', 'retailer-a', 'https://shop.test/a', 'Arroz tipo 1 pacote',
       '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'),
      ('product-b', 'retailer-b', 'https://shop.test/b', 'Feijao carioca pacote',
       '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z');

    INSERT INTO runs
      (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
       status, attempted, ok, failed, started_at)
    VALUES
      ('discover-a', 'retailer-a', 'discover', '2026-07-10',
       'retailer-a-discovery-v1', 1, 'running', 0, 0, 0,
       '2026-07-10T00:00:00.000Z'),
      ('collect-a', 'retailer-a', 'collect', '2026-07-10',
       'retailer-a-extraction-v1', 1, 'running', 0, 0, 0,
       '2026-07-10T00:00:00.000Z');
  `);
  return database;
}

describe("core evidence identity guards", () => {
  it("rejects cross-retailer/stage scope evidence and rolls back snapshot effects", () => {
    const database = evidenceDatabase();
    const insertScope = database.prepare(`
      INSERT INTO product_scope_decisions
        (id, product_id, run_id, in_scope, reason, rule_version, decided_at)
      VALUES (?, ?, ?, 1, 'fixture', 'v1', '2026-07-10T12:00:00.000Z')
    `);
    expect(() => insertScope.run("scope-cross", "product-b", "discover-a"))
      .toThrow(/running discovery run/iu);
    expect(() => insertScope.run("scope-stage", "product-a", "collect-a"))
      .toThrow(/running discovery run/iu);

    expect(() => recordCatalogSnapshot(database, {
      runId: "discover-a",
      retailerId: "retailer-b",
      complete: true,
      completionReason: "source_exhausted",
      discovered: 1,
      inScope: 1,
      outOfScope: 0,
      completedAt: "2026-07-10T12:00:00.000Z",
    })).toThrow(/running discovery run/iu);
    expect(database.prepare(
      "SELECT active FROM products WHERE id = 'product-b'",
    ).get()).toEqual({ active: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_snapshots").get())
      .toEqual({ count: 0 });
    expect(() => recordCatalogSnapshot(database, {
      runId: "collect-a",
      retailerId: "retailer-a",
      complete: false,
      completionReason: "fixture",
      discovered: 0,
      inScope: 0,
      outOfScope: 0,
      completedAt: "2026-07-10T12:00:00.000Z",
    })).toThrow(/running discovery run/iu);
  });

  it("rejects mismatched observations and failures even without replay fields", () => {
    const database = evidenceDatabase();
    const insertObservation = database.prepare(`
      INSERT INTO observations
        (id, product_id, run_id, strategy_id, strategy_version, observed_at,
         collection_day, title, price_cents)
      VALUES (?, ?, 'collect-a', ?, 1, '2026-07-10T12:00:00.000Z', ?,
              'Arroz tipo 1 pacote', 1000)
    `);
    expect(() => insertObservation.run(
      "observation-cross",
      "product-b",
      "retailer-a-extraction-v1",
      "2026-07-10",
    )).toThrow(/running collection run/iu);
    expect(() => insertObservation.run(
      "observation-day",
      "product-a",
      "retailer-a-extraction-v1",
      "2026-07-11",
    )).toThrow(/running collection run/iu);
    expect(() => insertObservation.run(
      "observation-strategy",
      "product-a",
      "retailer-b-extraction-v1",
      "2026-07-10",
    )).toThrow(/running collection run/iu);

    const insertFailure = database.prepare(`
      INSERT INTO run_failures
        (id, run_id, retailer_id, product_id, category, message,
         strategy_id, strategy_version, occurred_at)
      VALUES (?, 'collect-a', ?, ?, 'parse', 'fixture', ?, 1,
              '2026-07-10T12:00:00.000Z')
    `);
    expect(() => insertFailure.run(
      "failure-retailer",
      "retailer-b",
      null,
      "retailer-a-extraction-v1",
    )).toThrow(/running run/iu);
    expect(() => insertFailure.run(
      "failure-product",
      "retailer-a",
      "product-b",
      "retailer-a-extraction-v1",
    )).toThrow(/running run/iu);
    expect(() => insertFailure.run(
      "failure-strategy",
      "retailer-a",
      null,
      "retailer-b-extraction-v1",
    )).toThrow(/running run/iu);

    database.prepare(`
      UPDATE runs SET status = 'failed', finished_at = '2026-07-10T13:00:00.000Z'
      WHERE id = 'collect-a'
    `).run();
    expect(() => insertFailure.run(
      "failure-terminal",
      "retailer-a",
      null,
      "retailer-a-extraction-v1",
    )).toThrow(/running run/iu);
  });
});
