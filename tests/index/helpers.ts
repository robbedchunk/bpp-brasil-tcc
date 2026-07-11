import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

import { loadIpcaItems } from "../../scripts/load-ipca-items.js";
import { openDatabase } from "../../src/db/database.js";
import { buildDailyIndex as buildProductionDailyIndex } from "../../src/index/aggregate.js";

const authoritativeWeights = readFileSync(new URL(
  "../../data/reference/ipca_pof2017_2018_sp_food_at_home_weights.csv",
  import.meta.url,
), "utf8");

const terminalRuns = new WeakMap<Database.Database, Map<string, {
  status: "completed" | "partial" | "failed";
  finishedAt: string;
}>>();

export function indexDatabase(): Database.Database {
  return openDatabase(":memory:");
}

export function seedAuthoritativeWeights(database: Database.Database): void {
  loadIpcaItems(database, authoritativeWeights);
}

export function seedRetailer(database: Database.Database, id: string): void {
  database.prepare(`
    INSERT INTO retailers (id, name, base_url, cep, domains_json, active)
    VALUES (?, ?, ?, '01310-100', ?, 1)
  `).run(id, `Retailer ${id}`, `https://${id}.test`, JSON.stringify([`${id}.test`]));
  database.prepare(`
    INSERT INTO strategies
      (id, retailer_id, purpose, tier, version, strategy_json, provenance,
       validation_sample_size, validation_successes, validation_rate, active)
    VALUES (?, ?, 'extraction', 1, 1, '{}', 'index-test', 30, 30, 1, 0)
  `).run(`${id}-strategy`, id);
  database.prepare(`
    INSERT INTO strategy_validation_evidence
      (strategy_id, receipt_path, receipt_sha256, sample_set_sha256,
       executor_json, attestation_key_id, attempted, valid, score, validated_at)
    VALUES (?, ?, ?, ?, '{}', ?, 30, 30, 1, '2026-01-01T00:00:00.000Z')
  `).run(
    `${id}-strategy`,
    `data/validation/${id}-strategy.json`,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  );
  database.prepare(
    "UPDATE strategies SET active = 1 WHERE id = ?",
  ).run(`${id}-strategy`);
}

export function seedItem(
  database: Database.Database,
  id: string,
  code: string,
  name: string,
  weightText: string,
): void {
  database.prepare(`
    INSERT INTO ipca_items
      (id, code, parent_code, name, item_group, weight, weight_text,
       weight_period, source_url, citation, in_scope, source_archive_sha256)
    VALUES (?, ?, '1100000', ?, 'alimentacao_no_domicilio', ?, ?,
            '2019-12', 'https://ibge.gov.br/source', 'fixture', 1, ?)
  `).run(id, code, name, Number(weightText), weightText, "a".repeat(64));
}

export function seedProduct(
  database: Database.Database,
  input: {
    id: string;
    retailerId: string;
    itemId: string | null;
    version?: number;
    confidence?: number;
    inScope?: boolean;
    active?: boolean;
  },
): void {
  database.prepare(`
    INSERT INTO products
      (id, retailer_id, canonical_url, title, in_scope, active, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z')
  `).run(
    input.id,
    input.retailerId,
    `https://${input.retailerId}.test/p/${input.id}`,
    input.id,
    input.inScope === false ? 0 : 1,
    input.active === false ? 0 : 1,
  );
  const version = input.version ?? 1;
  database.prepare(`
    INSERT INTO classifications
      (id, product_id, ipca_item_id, version, decision, confidence, method,
       created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'rule', ?)
  `).run(
    `${input.id}-classification-v${version}`,
    input.id,
    input.itemId,
    version,
    input.itemId === null ? "unclassified" : input.itemId,
    input.confidence ?? 0.99,
    `2026-01-0${Math.min(version, 9)}T00:00:00.000Z`,
  );
}

export function seedRun(
  database: Database.Database,
  input: {
    id: string;
    retailerId: string;
    day: string;
    attempted?: number;
    ok?: number;
    status?: "completed" | "partial" | "failed" | "running";
    startedAt?: string;
  },
): void {
  const attempted = input.attempted ?? 1;
  const ok = input.ok ?? attempted;
  const status = input.status ?? "completed";
  const startedAt = input.startedAt ?? `${input.day}T06:00:00.000Z`;
  database.prepare(`
    INSERT INTO runs
      (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
       status, attempted, ok, failed, started_at, finished_at)
    VALUES (?, ?, 'collect', ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.retailerId,
    input.day,
    `${input.retailerId}-strategy`,
    "running",
    attempted,
    ok,
    attempted - ok,
    startedAt,
    null,
  );
  if (status !== "running") {
    const pending = terminalRuns.get(database) ?? new Map();
    pending.set(input.id, {
      status,
      finishedAt: startedAt.replace("06:00", "06:10"),
    });
    terminalRuns.set(database, pending);
  }
}

export function finalizeSeedRuns(database: Database.Database): void {
  const pending = terminalRuns.get(database);
  if (pending === undefined || pending.size === 0) return;
  const finish = database.prepare(`
    UPDATE runs SET status = ?, finished_at = ?
    WHERE id = ? AND status = 'running' AND finished_at IS NULL
  `);
  database.transaction(() => {
    for (const [runId, target] of pending) {
      finish.run(target.status, target.finishedAt, runId);
    }
  }).immediate();
  pending.clear();
}

export function buildSeededDailyIndex(
  database: Database.Database,
  options?: Parameters<typeof buildProductionDailyIndex>[1],
): ReturnType<typeof buildProductionDailyIndex> {
  finalizeSeedRuns(database);
  return buildProductionDailyIndex(database, options);
}

export function seedObservation(
  database: Database.Database,
  input: {
    id: string;
    productId: string;
    runId: string;
    day: string;
    price: number;
    promo?: number | null;
    available?: boolean;
    observedAt?: string;
  },
): void {
  const retailer = database.prepare(
    "SELECT retailer_id FROM products WHERE id = ?",
  ).get(input.productId) as { retailer_id: string };
  database.prepare(`
    INSERT INTO observations
      (id, product_id, run_id, strategy_id, strategy_version, observed_at,
       collection_day, price_cents, promo_price_cents, available)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.productId,
    input.runId,
    `${retailer.retailer_id}-strategy`,
    input.observedAt ?? `${input.day}T06:05:00.000Z`,
    input.day,
    input.price,
    input.promo ?? null,
    input.available === false ? 0 : 1,
  );
}
