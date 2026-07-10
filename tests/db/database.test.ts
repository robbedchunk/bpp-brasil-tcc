import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db/database.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
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

function seedEvidenceGraph(database: ReturnType<typeof openDatabase>): void {
  insertRetailer(database);
  database.exec(`
    INSERT INTO ipca_items
      (id, code, name, weight, weight_period, source_url, citation)
    VALUES
      ('ipca-1', '1101002', 'Arroz', 1.5, '2026-01', 'https://sidra.ibge.gov.br', 'IBGE');

    INSERT INTO strategies
      (id, retailer_id, purpose, tier, version, strategy_json, provenance, active)
    VALUES
      ('strategy-1', 'retailer-1', 'extraction', 1, 1, '{}', 'hand-authored', 1),
      ('strategy-2', 'retailer-1', 'extraction', 2, 2, '{}', 'generated', 0);

    INSERT INTO products
      (id, retailer_id, canonical_url, title, first_seen, last_seen)
    VALUES
      ('product-1', 'retailer-1', 'https://mercado.example/arroz', 'Arroz',
       '2026-07-10T03:00:00.000Z', '2026-07-10T03:00:00.000Z');

    INSERT INTO runs
      (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
       status, attempted, ok, failed, started_at)
    VALUES
      ('run-1', 'retailer-1', 'collect', '2026-07-10', 'strategy-1', 1,
       'running', 1, 1, 0, '2026-07-10T03:00:00.000Z');

    INSERT INTO observations
      (id, product_id, run_id, strategy_id, strategy_version, observed_at,
       collection_day, price_cents, promo_price_cents)
    VALUES
      ('observation-1', 'product-1', 'run-1', 'strategy-1', 1,
       '2026-07-10T03:00:30.000Z', '2026-07-10', 1000, 899);

    INSERT INTO run_failures
      (id, run_id, retailer_id, product_id, category, message, occurred_at)
    VALUES
      ('failure-1', 'run-1', 'retailer-1', 'product-1', 'parse', 'bad markup',
       '2026-07-10T03:00:40.000Z');

    INSERT INTO classifications
      (id, product_id, ipca_item_id, version, decision, confidence, method)
    VALUES
      ('classification-1', 'product-1', 'ipca-1', 1, '1101002', 0.95, 'rule');

    INSERT INTO exploration_runs
      (id, retailer_id, purpose, trigger, previous_strategy_id, status,
       event_budget, started_at)
    VALUES
      ('exploration-1', 'retailer-1', 'extraction', 'drift', 'strategy-1',
       'running', 3, '2026-07-10T04:00:00.000Z');

    INSERT INTO healing_events
      (id, retailer_id, purpose, onset_run_id, previous_strategy_id, category,
       status, tier_from, drift_started_at, detected_at)
    VALUES
      ('healing-1', 'retailer-1', 'extraction', 'run-1', 'strategy-1', 'drift',
       'detected', 1, '2026-07-10T03:00:00.000Z', '2026-07-10T03:10:00.000Z');

    INSERT INTO heartbeats
      (id, pipeline, retailer_id, run_id, scheduled_for, completed_at, status)
    VALUES
      ('heartbeat-1', 'collect', 'retailer-1', 'run-1',
       '2026-07-10T03:00:00.000Z', '2026-07-10T03:05:00.000Z', 'completed');

    INSERT INTO cost_ledger
      (id, category, retailer_id, exploration_run_id, classification_id,
       provider, model, input_tokens, output_tokens, cost_usd, occurred_at)
    VALUES
      ('cost-1', 'model', 'retailer-1', 'exploration-1', 'classification-1',
       'openai', 'test-model', 100, 20, 0.05, '2026-07-10T04:01:00.000Z');
  `);
}

function initializeDatabaseInChild(
  databasePath: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "db", "init"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_PATH: databasePath },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveResult({ exitCode, stderr });
    });
  });
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
    expect(database.pragma("recursive_triggers", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 5 });

    database.exec("SELECT 1");
    expect(() => openMemoryDatabase()).not.toThrow();
  });

  it("serializes concurrent first-time migrations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "precos.sqlite");

    const results = await Promise.all(
      Array.from({ length: 8 }, () => initializeDatabaseInChild(databasePath)),
    );

    expect(results).toEqual(
      Array.from({ length: 8 }, () => ({ exitCode: 0, stderr: "" })),
    );
    const database = openDatabase(databasePath);
    databases.push(database);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 5 });
  });

  it("creates a private parent directory for a new production database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-parent-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "data", "precos.sqlite");

    const database = openDatabase(databasePath);
    databases.push(database);

    await expect(stat(join(directory, "data")).then((value) => value.mode & 0o777))
      .resolves.toBe(0o700);
  });

  it("rejects deletion from every append-only evidence table", () => {
    const database = openMemoryDatabase();
    seedEvidenceGraph(database);

    for (const table of [
      "cost_ledger",
      "heartbeats",
      "healing_events",
      "exploration_runs",
      "classifications",
      "run_failures",
      "observations",
      "runs",
      "strategies",
    ]) {
      expect(() => database.prepare(`DELETE FROM ${table}`).run()).toThrow(
        /append-only/,
      );
    }
  });

  it("rejects updates to immutable evidence facts", () => {
    const database = openMemoryDatabase();
    seedEvidenceGraph(database);

    for (const statement of [
      "UPDATE observations SET price_cents = 950 WHERE id = 'observation-1'",
      "UPDATE run_failures SET message = 'rewritten' WHERE id = 'failure-1'",
      "UPDATE classifications SET confidence = 0 WHERE id = 'classification-1'",
      "UPDATE heartbeats SET status = 'failed' WHERE id = 'heartbeat-1'",
      "UPDATE cost_ledger SET cost_usd = 0 WHERE id = 'cost-1'",
    ]) {
      expect(() => database.exec(statement)).toThrow(/immutable/);
    }
  });

  it("allows documented lifecycle transitions", () => {
    const database = openMemoryDatabase();
    seedEvidenceGraph(database);

    database.exec(`
      UPDATE strategies
      SET validation_sample_size = 30,
          validation_successes = 27,
          validation_rate = 0.9,
          validated_at = '2026-07-10T04:05:00.000Z',
          activated_at = '2026-07-10T04:06:00.000Z'
      WHERE id = 'strategy-1';

      UPDATE runs
      SET status = 'completed',
          attempted = 2,
          ok = 1,
          failed = 1,
          finished_at = '2026-07-10T03:05:00.000Z',
          metadata_json = '{"fixture":true}'
      WHERE id = 'run-1';

      UPDATE exploration_runs
      SET candidate_strategy_id = 'strategy-2',
          status = 'completed',
          outcome = 'validated',
          events_used = 2,
          input_tokens = 100,
          output_tokens = 20,
          cost_usd = 0.05,
          artifact_json = '{"strategy":{}}',
          finished_at = '2026-07-10T04:10:00.000Z'
      WHERE id = 'exploration-1';

      UPDATE healing_events
      SET successor_strategy_id = 'strategy-2',
          status = 'recovered',
          attempts = 1,
          tier_to = 2,
          recovered_at = '2026-07-10T04:10:00.000Z',
          duration_seconds = 4200,
          details_json = '{"validated":true}'
      WHERE id = 'healing-1';
    `);

    expect(
      database.prepare("SELECT status, attempted, ok, failed FROM runs").get(),
    ).toEqual({ status: "completed", attempted: 2, ok: 1, failed: 1 });
    expect(
      database.prepare("SELECT status, candidate_strategy_id FROM exploration_runs").get(),
    ).toEqual({ status: "completed", candidate_strategy_id: "strategy-2" });
    expect(
      database.prepare("SELECT status, successor_strategy_id FROM healing_events").get(),
    ).toEqual({ status: "recovered", successor_strategy_id: "strategy-2" });
  });

  it("rejects lifecycle rewrites of identity and provenance", () => {
    const database = openMemoryDatabase();
    seedEvidenceGraph(database);

    for (const statement of [
      `UPDATE strategies SET strategy_json = '{"rewritten":true}'
       WHERE id = 'strategy-1'`,
      "UPDATE runs SET collection_day = '2026-07-09' WHERE id = 'run-1'",
      "UPDATE exploration_runs SET trigger = 'manual' WHERE id = 'exploration-1'",
      `UPDATE healing_events SET detected_at = '2026-07-10T04:00:00.000Z'
       WHERE id = 'healing-1'`,
    ]) {
      expect(() => database.exec(statement)).toThrow(/immutable/);
    }
  });

  it("rejects INSERT OR REPLACE for fully immutable facts", () => {
    const database = openMemoryDatabase();
    seedEvidenceGraph(database);

    expect(() =>
      database.exec(`
        INSERT OR REPLACE INTO heartbeats
          (id, pipeline, retailer_id, run_id, scheduled_for, completed_at, status)
        VALUES
          ('heartbeat-1', 'collect', 'retailer-1', 'run-1',
           '2026-07-10T03:00:00.000Z', '2026-07-10T03:05:00.000Z', 'rewritten')
      `),
    ).toThrow(/append-only/);
  });

  it("rejects INSERT OR REPLACE for lifecycle history", () => {
    const database = openMemoryDatabase();
    seedEvidenceGraph(database);

    expect(() =>
      database.exec(`
        INSERT OR REPLACE INTO healing_events
          (id, retailer_id, purpose, onset_run_id, previous_strategy_id, category,
           status, tier_from, drift_started_at, detected_at)
        VALUES
          ('healing-1', 'retailer-1', 'extraction', 'run-1', 'strategy-1',
           'rewritten', 'recovered', 1, '2026-07-10T03:00:00.000Z',
           '2026-07-10T03:10:00.000Z')
      `),
    ).toThrow(/append-only/);
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
    expect(defaults.databasePath).toBe(resolve(defaults.projectRoot, "data/precos.sqlite"));

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
