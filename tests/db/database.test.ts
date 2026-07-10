import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/database.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function openMemoryDatabase(): ReturnType<typeof openDatabase> {
  const database = openDatabase(":memory:");
  databases.push(database);
  return database;
}

function insertRetailer(database: ReturnType<typeof openDatabase>): void {
  database
    .prepare(
      `INSERT INTO retailers (id, name, base_url, cep, domains_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "retailer-1",
      "Mercado Teste",
      "https://mercado.example",
      "01310-100",
      '["mercado.example"]',
    );
}

describe("database foundation", () => {
  it("creates every evidence table and enforces strategy activation uniqueness", () => {
    const database = openMemoryDatabase();
    const names = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row: any) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "retailers",
        "strategies",
        "products",
        "observations",
        "runs",
        "run_failures",
        "ipca_items",
        "classifications",
        "exploration_runs",
        "healing_events",
        "heartbeats",
        "cost_ledger",
        "schema_migrations",
      ]),
    );

    insertRetailer(database);
    const insertStrategy = database.prepare(
      `INSERT INTO strategies
         (id, retailer_id, purpose, tier, version, strategy_json, provenance, active)
       VALUES
         (@id, 'retailer-1', 'extraction', 1, @version, '{}', 'hand-authored', 1)`,
    );

    insertStrategy.run({ id: "strategy-1", version: 1 });
    expect(() =>
      insertStrategy.run({ id: "strategy-2", version: 2 }),
    ).toThrow(/UNIQUE/);
  });

  it("enforces foreign keys, product identity, and observation price checks", () => {
    const database = openMemoryDatabase();
    insertRetailer(database);

    const insertProduct = database.prepare(
      `INSERT INTO products
         (id, retailer_id, canonical_url, title, first_seen, last_seen)
       VALUES
         (@id, @retailerId, @canonicalUrl, 'Arroz', @seenAt, @seenAt)`,
    );
    const product = {
      id: "product-1",
      retailerId: "retailer-1",
      canonicalUrl: "https://mercado.example/arroz",
      seenAt: "2026-07-10T03:00:00.000Z",
    };

    insertProduct.run(product);
    expect(() =>
      insertProduct.run({ ...product, id: "product-2" }),
    ).toThrow(/UNIQUE/);
    expect(() =>
      insertProduct.run({
        ...product,
        id: "product-3",
        retailerId: "missing-retailer",
        canonicalUrl: "https://mercado.example/feijao",
      }),
    ).toThrow(/FOREIGN KEY/);

    database
      .prepare(
        `INSERT INTO runs
           (id, retailer_id, stage, collection_day, status, attempted, ok, failed,
            started_at, finished_at)
         VALUES
           ('run-1', 'retailer-1', 'collect', '2026-07-10', 'completed', 1, 1, 0,
            '2026-07-10T03:00:00.000Z', '2026-07-10T03:01:00.000Z')`,
      )
      .run();

    const insertObservation = database.prepare(
      `INSERT INTO observations
         (id, product_id, run_id, observed_at, collection_day, price_cents,
          promo_price_cents)
       VALUES
         (@id, 'product-1', 'run-1', '2026-07-10T03:00:30.000Z', '2026-07-10',
          @price, @promoPrice)`,
    );

    expect(() =>
      insertObservation.run({ id: "negative-price", price: -1, promoPrice: null }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertObservation.run({ id: "invalid-promo", price: 1_000, promoPrice: 1_001 }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertObservation.run({ id: "negative-promo", price: 1_000, promoPrice: -1 }),
    ).toThrow(/CHECK/);

    expect(
      insertObservation.run({ id: "valid-price", price: 1_000, promoPrice: 899 })
        .changes,
    ).toBe(1);
  });

  it("applies migrations idempotently with the required SQLite pragmas", () => {
    const database = openMemoryDatabase();

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 1 });

    database.exec("SELECT 1");
    expect(() => openMemoryDatabase()).not.toThrow();
  });
});

describe("configuration", () => {
  it("loads deterministic defaults and explicit environment overrides", () => {
    const defaults = loadConfig({});
    expect(defaults).toMatchObject({
      timezone: "America/Sao_Paulo",
      pageConcurrency: 4,
      dailyPageCap: 2_000,
    });

    expect(
      loadConfig({
        PROJECT_ROOT: "/srv/precos",
        DATABASE_PATH: "/data/precos.sqlite",
        PAGE_CONCURRENCY: "3",
        DAILY_PAGE_CAP: "1800",
        OPENAI_API_KEY: "test-key",
        NTFY_TOPIC: "test-topic",
      }),
    ).toEqual({
      projectRoot: "/srv/precos",
      databasePath: "/data/precos.sqlite",
      timezone: "America/Sao_Paulo",
      pageConcurrency: 3,
      dailyPageCap: 1_800,
      openaiApiKey: "test-key",
      ntfyTopic: "test-topic",
    });
  });

  it("rejects unsafe numeric configuration", () => {
    expect(() => loadConfig({ PAGE_CONCURRENCY: "0" })).toThrow(
      /PAGE_CONCURRENCY/,
    );
    expect(() => loadConfig({ DAILY_PAGE_CAP: "many" })).toThrow(
      /DAILY_PAGE_CAP/,
    );
  });
});
