import { afterEach, describe, expect, it } from "vitest";

import {
  CATALOG_SEED_MINIMUM_REFERENCES,
  CatalogSeedImportError,
  importCatalogSeeds,
  parseCatalogSeedFile,
  type CatalogSeedEntry,
} from "../../src/catalog/import.js";
import { openDatabase } from "../../src/db/database.js";
import { selectStrategyValidationChallenge } from "../../src/strategies/validation-challenge.js";
import { discoveryStrategy, seedStrategy } from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function createDatabase(): ReturnType<typeof openDatabase> {
  const database = openDatabase(":memory:");
  databases.push(database);
  return database;
}

function seedInactiveRetailer(
  database: ReturnType<typeof openDatabase>,
  id = "r1",
  active = 0,
): void {
  database.prepare(
    `INSERT INTO retailers (id, name, base_url, cep, domains_json, active)
     VALUES (?, ?, 'https://shop.test', '01310-100', '["shop.test"]', ?)`,
  ).run(id, `Retailer ${id}`, active);
}

function seedEntries(count: number, offset = 0): CatalogSeedEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    canonicalUrl: `https://shop.test/produto/arroz-integral-${index + offset}/p`,
    externalId: String(1_000 + index + offset),
    sourceCategory: "Mercearia",
    title: null,
  }));
}

const FILE_SHA = "a".repeat(64);

function runImport(
  database: ReturnType<typeof openDatabase>,
  overrides: Partial<Parameters<typeof importCatalogSeeds>[1]> = {},
): ReturnType<typeof importCatalogSeeds> {
  return importCatalogSeeds(database, {
    retailerId: "r1",
    entries: seedEntries(30),
    sourceLabel: "sonda-seeds.json",
    fileSha256: FILE_SHA,
    now: () => new Date("2026-07-16T12:00:00.000Z"),
    ...overrides,
  });
}

describe("importCatalogSeeds", () => {
  it("imports a 30-reference cold-start seed and makes the challenge selectable", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);

    const summary = runImport(database);

    expect(summary).toMatchObject({
      retailerId: "r1",
      sourceLabel: "sonda-seeds.json",
      fileSha256: FILE_SHA,
      dryRun: false,
      alreadyImported: false,
      refs: 30,
      newProducts: 30,
      refreshedProducts: 0,
      activeInScopeProducts: 30,
      challengeReady: true,
    });
    expect(summary.importId).not.toBeNull();

    const products = database.prepare(
      `SELECT COUNT(*) AS count FROM products
       WHERE retailer_id = 'r1' AND active = 1 AND in_scope = 1`,
    ).get() as { count: number };
    expect(products.count).toBe(30);

    const challenge = selectStrategyValidationChallenge(database, "r1", 30);
    expect(challenge).toHaveLength(CATALOG_SEED_MINIMUM_REFERENCES);
    expect(challenge[0]).toMatchObject({ sourceCategory: "Mercearia" });

    // No network ever happened, so no admission ledger may be charged.
    for (const table of ["request_admissions", "discovery_reference_admissions"]) {
      const admissions = database.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).get() as { count: number };
      expect(admissions.count).toBe(0);
    }
  });

  it("prefers the latest completed discovery cohort over older active seed rows", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);
    runImport(database, { entries: seedEntries(40) });
    const strategyId = seedStrategy(database, "discovery", discoveryStrategy, "r1");
    database.prepare(
      `INSERT INTO runs
         (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
          status, attempted, ok, failed, started_at)
       VALUES
         ('current-cohort', 'r1', 'discover', '2026-07-17', ?, 1,
          'running', 0, 0, 0, '2026-07-17T03:00:00.000Z')`,
    ).run(strategyId);
    const products = database.prepare(
      `SELECT id, canonical_url AS canonicalUrl, source_category AS sourceCategory
       FROM products WHERE retailer_id = 'r1'
       ORDER BY canonical_url`,
    ).all() as Array<{ id: string; canonicalUrl: string; sourceCategory: string }>;
    const insertDecision = database.prepare(
      `INSERT INTO product_scope_decisions
         (id, product_id, run_id, in_scope, source_category, reason,
          evidence_json, rule_version, decided_at)
       VALUES (?, ?, 'current-cohort', 1, ?, 'included_category', '{}',
               'food-at-home-category-v1', '2026-07-17T03:01:00.000Z')`,
    );
    for (const [index, product] of products.slice(10).entries()) {
      insertDecision.run(`current-decision-${index}`, product.id, product.sourceCategory);
    }
    database.prepare(
      `UPDATE runs
       SET status = 'completed', attempted = 30, ok = 30, failed = 0,
           finished_at = '2026-07-17T03:02:00.000Z'
       WHERE id = 'current-cohort'`,
    ).run();

    const challenge = selectStrategyValidationChallenge(database, "r1", 30);

    expect(challenge).toHaveLength(30);
    expect(challenge.map(({ canonicalUrl }) => canonicalUrl).sort())
      .toEqual(products.slice(10).map(({ canonicalUrl }) => canonicalUrl).sort());
  });

  it("marks seed provenance distinguishably from discovery evidence", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);

    const summary = runImport(database);

    const importRow = database.prepare(
      "SELECT * FROM catalog_seed_imports WHERE id = ?",
    ).get(summary.importId) as Record<string, unknown>;
    expect(importRow).toMatchObject({
      retailer_id: "r1",
      source_label: "sonda-seeds.json",
      file_sha256: FILE_SHA,
      ref_count: 30,
      imported_at: "2026-07-16T12:00:00.000Z",
    });

    const seedRefs = database.prepare(
      `SELECT COUNT(*) AS count FROM catalog_seed_refs
       WHERE import_id = ? AND retailer_id = 'r1' AND in_scope = 1
         AND reason = 'included_category'
         AND rule_version = 'food-at-home-category-v1'`,
    ).get(summary.importId) as { count: number };
    expect(seedRefs.count).toBe(30);

    const linked = database.prepare(
      `SELECT COUNT(*) AS count FROM catalog_seed_refs
       JOIN products ON products.id = catalog_seed_refs.product_id
       WHERE products.canonical_url = catalog_seed_refs.canonical_url`,
    ).get() as { count: number };
    expect(linked.count).toBe(30);

    // Discovery evidence stays empty: seeds never masquerade as discovery.
    const scopeDecisions = database.prepare(
      "SELECT COUNT(*) AS count FROM product_scope_decisions",
    ).get() as { count: number };
    expect(scopeDecisions.count).toBe(0);
  });

  it("refuses the whole import when a reference is out of scope", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);
    const entries = [...seedEntries(30), {
      canonicalUrl: "https://shop.test/produto/detergente-500ml/p",
      externalId: null,
      sourceCategory: "Limpeza",
      title: null,
    }];

    let caught: unknown;
    try {
      runImport(database, { entries });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CatalogSeedImportError);
    const rejectionError = caught as CatalogSeedImportError;
    expect(rejectionError.rejections).toHaveLength(1);
    expect(rejectionError.rejections[0]).toMatchObject({
      index: 30,
      canonicalUrl: "https://shop.test/produto/detergente-500ml/p",
    });
    expect(rejectionError.rejections[0]?.reason).toContain("out of food-at-home scope");
    expect(rejectionError.rejections[0]?.reason).toContain("limpeza");

    const written = database.prepare(
      `SELECT (SELECT COUNT(*) FROM products) AS products,
              (SELECT COUNT(*) FROM catalog_seed_imports) AS imports,
              (SELECT COUNT(*) FROM catalog_seed_refs) AS refs`,
    ).get();
    expect(written).toEqual({ products: 0, imports: 0, refs: 0 });
  });

  it("rejects references outside the registered domain allowlist", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);
    const entries = [...seedEntries(29), {
      canonicalUrl: "https://other.test/produto/arroz/p",
      externalId: null,
      sourceCategory: "Mercearia",
      title: null,
    }];

    expect(() => runImport(database, { entries }))
      .toThrow(/not in the retailer allowlist: other\.test/u);
    expect((database.prepare("SELECT COUNT(*) AS count FROM products").get() as {
      count: number;
    }).count).toBe(0);
  });

  it("rejects duplicate canonical URLs inside one seed file", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);
    const entries = [...seedEntries(30), ...seedEntries(1)];

    expect(() => runImport(database, { entries }))
      .toThrow(/duplicate canonical URL/u);
  });

  it("refuses fewer than 30 in-scope references", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);

    expect(() => runImport(database, { entries: seedEntries(29) }))
      .toThrow(/at least 30 in-scope references; the seed file has 29/u);
    expect((database.prepare("SELECT COUNT(*) AS count FROM catalog_seed_imports").get() as {
      count: number;
    }).count).toBe(0);
  });

  it("refuses seed files above the catalog cap", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);

    expect(() => runImport(database, { entries: seedEntries(3_001) }))
      .toThrow(/3000-product catalog cap/u);
  });

  it("refuses an unregistered retailer with registration guidance", () => {
    const database = createDatabase();

    expect(() => runImport(database))
      .toThrow(/not registered.*bootstrap-inactive/u);
  });

  it("refuses to touch an ACTIVE retailer's catalog", () => {
    const database = createDatabase();
    seedInactiveRetailer(database, "r1", 1);

    expect(() => runImport(database)).toThrow(/cold-start only/u);
    expect((database.prepare("SELECT COUNT(*) AS count FROM products").get() as {
      count: number;
    }).count).toBe(0);
  });

  it("refuses a retailer that already has an active strategy", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy, "r1");

    expect(() => runImport(database)).toThrow(/active strategy.*cold-start only/u);
  });

  it("fails closed at the SQLite trigger even for direct SQL against an active retailer", () => {
    const database = createDatabase();
    seedInactiveRetailer(database, "r1", 1);

    expect(() => database.prepare(
      `INSERT INTO catalog_seed_imports
         (id, retailer_id, source_label, file_sha256, ref_count, imported_at)
       VALUES ('direct', 'r1', 'x.json', ?, 30, '2026-07-16T12:00:00.000Z')`,
    ).run(FILE_SHA)).toThrow(/operator catalog seeds are cold-start only/u);
  });

  it("keeps seed evidence append-only and immutable", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);
    const summary = runImport(database);

    expect(() => database.prepare(
      "UPDATE catalog_seed_imports SET ref_count = 31 WHERE id = ?",
    ).run(summary.importId)).toThrow(/immutable/u);
    expect(() => database.prepare(
      "DELETE FROM catalog_seed_refs WHERE import_id = ?",
    ).run(summary.importId)).toThrow(/append-only/u);
  });

  it("is idempotent for an identical re-import", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);
    const first = runImport(database);
    const second = runImport(database);

    expect(second).toMatchObject({
      alreadyImported: true,
      importId: first.importId,
      newProducts: 0,
      refreshedProducts: 0,
      activeInScopeProducts: 30,
      challengeReady: true,
    });
    const counts = database.prepare(
      `SELECT (SELECT COUNT(*) FROM products) AS products,
              (SELECT COUNT(*) FROM catalog_seed_imports) AS imports,
              (SELECT COUNT(*) FROM catalog_seed_refs) AS refs`,
    ).get();
    expect(counts).toEqual({ products: 30, imports: 1, refs: 30 });
  });

  it("records a distinct import when a corrected file overlaps existing seeds", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);
    runImport(database);

    const second = runImport(database, {
      entries: [...seedEntries(30), ...seedEntries(5, 100)],
      fileSha256: "b".repeat(64),
      sourceLabel: "sonda-seeds-v2.json",
    });

    expect(second).toMatchObject({
      alreadyImported: false,
      refs: 35,
      newProducts: 5,
      refreshedProducts: 30,
      activeInScopeProducts: 35,
    });
    const counts = database.prepare(
      `SELECT (SELECT COUNT(*) FROM products) AS products,
              (SELECT COUNT(*) FROM catalog_seed_imports) AS imports,
              (SELECT COUNT(*) FROM catalog_seed_refs) AS refs`,
    ).get();
    expect(counts).toEqual({ products: 35, imports: 2, refs: 65 });
  });

  it("plans without writing in dry-run mode", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);

    const plan = runImport(database, { dryRun: true });

    expect(plan).toMatchObject({
      dryRun: true,
      importId: null,
      refs: 30,
      newProducts: 30,
      activeInScopeProducts: 30,
      challengeReady: true,
    });
    const counts = database.prepare(
      `SELECT (SELECT COUNT(*) FROM products) AS products,
              (SELECT COUNT(*) FROM catalog_seed_imports) AS imports`,
    ).get();
    expect(counts).toEqual({ products: 0, imports: 0 });
  });

  it("never stores a private absolute path as the source label", () => {
    const database = createDatabase();
    seedInactiveRetailer(database);

    expect(() => runImport(database, { sourceLabel: "/home/operator/seeds.json" }))
      .toThrow(/never a private absolute path/u);
  });
});

describe("parseCatalogSeedFile", () => {
  it("parses a JSON reference array", () => {
    const entries = parseCatalogSeedFile(JSON.stringify([
      {
        canonicalUrl: "https://shop.test/produto/cafe-torrado-500g/p",
        externalId: "42",
        sourceCategory: "Mercearia",
      },
      { canonicalUrl: "https://shop.test/produto/feijao-carioca-1kg/p" },
    ]), "json");

    expect(entries).toEqual([
      {
        canonicalUrl: "https://shop.test/produto/cafe-torrado-500g/p",
        externalId: "42",
        sourceCategory: "Mercearia",
        title: null,
      },
      {
        canonicalUrl: "https://shop.test/produto/feijao-carioca-1kg/p",
        externalId: null,
        sourceCategory: null,
        title: null,
      },
    ]);
  });

  it("parses a CSV file with empty cells as null", () => {
    const entries = parseCatalogSeedFile([
      "canonical_url,external_id,source_category,title",
      "https://shop.test/produto/cafe-torrado-500g/p,42,Mercearia,Café Torrado 500g",
      "https://shop.test/produto/feijao-carioca-1kg/p,,,",
    ].join("\n"), "csv");

    expect(entries).toEqual([
      {
        canonicalUrl: "https://shop.test/produto/cafe-torrado-500g/p",
        externalId: "42",
        sourceCategory: "Mercearia",
        title: "Café Torrado 500g",
      },
      {
        canonicalUrl: "https://shop.test/produto/feijao-carioca-1kg/p",
        externalId: null,
        sourceCategory: null,
        title: null,
      },
    ]);
  });

  it("rejects malformed JSON entries with a located reason", () => {
    expect(() => parseCatalogSeedFile(JSON.stringify([{ externalId: "42" }]), "json"))
      .toThrow(/#1 .*canonicalUrl/u);
    expect(() => parseCatalogSeedFile("{}", "json"))
      .toThrow(/top-level array/u);
  });

  it("rejects unknown CSV columns", () => {
    expect(() => parseCatalogSeedFile(
      "canonical_url,price\nhttps://shop.test/p,10",
      "csv",
    )).toThrow(/unknown CSV column/u);
  });
});
