import type Database from "better-sqlite3";

import { randomUUID } from "node:crypto";

import { normalizeUnit } from "../normalize/unit.js";
import {
  DiscoveryStrategySchema,
  ExtractionStrategySchema,
  StrategySchema,
  type DiscoveryStrategy,
  type ExtractionStrategy,
  type Strategy,
} from "../strategies/schema.js";
import type {
  ExtractionFailure,
  ExtractionResult,
  ProductRef,
} from "../strategies/types.js";

export interface ActiveStrategy<T> {
  id: string;
  retailerId: string;
  purpose: "discovery" | "extraction";
  version: number;
  strategy: T;
}

interface ActiveStrategyRow {
  id: string;
  retailer_id: string;
  purpose: "discovery" | "extraction";
  version: number;
  strategy_json: string;
}

export interface NewRun {
  id: string;
  retailerId: string;
  stage: "discover" | "collect";
  collectionDay: string;
  strategyId: string;
  strategyVersion: number;
  startedAt: string;
}

export interface RunCounters {
  attempted: number;
  ok: number;
  failed: number;
}

export interface ReplayReference {
  path: string;
  sha256: string;
}

export interface StoredProductRef extends ProductRef {
  id: string;
}

export type StrategyPurpose = "discovery" | "extraction";

export interface RetailerExplorationContext {
  retailerId: string;
  baseUrl: string;
  allowedDomains: string[];
  previousStrategy: ActiveStrategy<Strategy> | null;
}

export interface ExplorationAttemptEvidence {
  explorationRunId: string;
  attemptNumber: number;
  model: string;
  promptVersion: string;
  promptHash: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costUsd: number;
  costEstimated: boolean;
  estimateSource: string;
  rateVersion: string;
  externalSampleSize?: number;
  externalSuccesses?: number;
  externalScore?: number;
  outcome: string;
  artifact?: unknown;
  errorMessage?: string;
  createdAt: string;
}

export interface ActivatedStrategy {
  id: string;
  version: number;
}

export function findActiveDiscoveryStrategy(
  database: Database.Database,
  retailerId: string,
): ActiveStrategy<DiscoveryStrategy> {
  const row = findActiveStrategyRow(database, retailerId, "discovery");
  return {
    id: row.id,
    retailerId: row.retailer_id,
    purpose: row.purpose,
    version: row.version,
    strategy: DiscoveryStrategySchema.parse(JSON.parse(row.strategy_json)),
  };
}

export function findActiveExtractionStrategy(
  database: Database.Database,
  retailerId: string,
): ActiveStrategy<ExtractionStrategy> {
  const row = findActiveStrategyRow(database, retailerId, "extraction");
  return {
    id: row.id,
    retailerId: row.retailer_id,
    purpose: row.purpose,
    version: row.version,
    strategy: ExtractionStrategySchema.parse(JSON.parse(row.strategy_json)),
  };
}

function findActiveStrategyRow(
  database: Database.Database,
  retailerId: string,
  purpose: "discovery" | "extraction",
): Omit<ActiveStrategyRow, "strategy_json"> & { strategy_json: string } {
  const row = database.prepare(
    `SELECT id, retailer_id, purpose, version, strategy_json
     FROM strategies
     WHERE retailer_id = ? AND purpose = ? AND active = 1
     ORDER BY version DESC
     LIMIT 1`,
  ).get(retailerId, purpose) as ActiveStrategyRow | undefined;
  if (row === undefined) {
    throw new Error(`No active ${purpose} strategy for retailer ${retailerId}`);
  }
  return row;
}

export function createRun(database: Database.Database, run: NewRun): void {
  database.prepare(
    `INSERT INTO runs
       (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
        status, attempted, ok, failed, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 0, 0, ?)`,
  ).run(
    run.id,
    run.retailerId,
    run.stage,
    run.collectionDay,
    run.strategyId,
    run.strategyVersion,
    run.startedAt,
  );
}

export function attemptedForDay(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
): number {
  const row = database.prepare(
    `SELECT COALESCE(SUM(attempted), 0) AS attempted
     FROM runs
     WHERE retailer_id = ? AND collection_day = ?`,
  ).get(retailerId, collectionDay) as { attempted: number };
  return row.attempted;
}

export function finalizeRun(
  database: Database.Database,
  runId: string,
  counters: RunCounters,
  status: "completed" | "partial" | "failed",
  finishedAt: string,
  error?: { category: string; message: string },
): void {
  if (counters.attempted !== counters.ok + counters.failed) {
    throw new Error("Run counters must satisfy attempted = ok + failed");
  }
  const result = database.prepare(
    `UPDATE runs
     SET status = ?, attempted = ?, ok = ?, failed = ?, finished_at = ?,
         error_category = ?, error_message = ?
     WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
  ).run(
    status,
    counters.attempted,
    counters.ok,
    counters.failed,
    finishedAt,
    error?.category ?? null,
    error?.message ?? null,
    runId,
  );
  if (result.changes !== 1) throw new Error(`Run ${runId} was already finalized or missing`);
}

function productTitle(ref: ProductRef): string {
  if (ref.externalId !== null && ref.externalId.trim().length > 0) return ref.externalId;
  try {
    const segment = new URL(ref.canonicalUrl).pathname.split("/").filter(Boolean).at(-1);
    if (segment !== undefined && segment.length > 0) return decodeURIComponent(segment);
  } catch {
    // The strategy layer normally canonicalizes URLs; retain a safe fallback for evidence.
  }
  return ref.canonicalUrl;
}

export function upsertDiscoveredProduct(
  database: Database.Database,
  retailerId: string,
  ref: ProductRef,
  seenAt: string,
): StoredProductRef {
  database.prepare(
    `INSERT INTO products
       (id, retailer_id, canonical_url, retailer_product_id, title,
        source_category, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (retailer_id, canonical_url) DO UPDATE SET
       retailer_product_id = COALESCE(excluded.retailer_product_id, products.retailer_product_id),
       source_category = COALESCE(excluded.source_category, products.source_category),
       last_seen = excluded.last_seen,
       active = 1,
       updated_at = excluded.last_seen`,
  ).run(
    randomUUID(),
    retailerId,
    ref.canonicalUrl,
    ref.externalId,
    productTitle(ref),
    ref.sourceCategory,
    seenAt,
    seenAt,
  );
  const row = database.prepare(
    `SELECT id, canonical_url, retailer_product_id, source_category
     FROM products WHERE retailer_id = ? AND canonical_url = ?`,
  ).get(retailerId, ref.canonicalUrl) as {
    id: string;
    canonical_url: string;
    retailer_product_id: string | null;
    source_category: string | null;
  };
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    externalId: row.retailer_product_id,
    sourceCategory: row.source_category,
  };
}

export function listCollectionProducts(
  database: Database.Database,
  retailerId: string,
  limit: number,
): StoredProductRef[] {
  return (database.prepare(
    `SELECT id, canonical_url, retailer_product_id, source_category
     FROM products
     WHERE retailer_id = ? AND active = 1 AND in_scope = 1
     ORDER BY last_seen DESC, id
     LIMIT ?`,
  ).all(retailerId, limit) as Array<{
    id: string;
    canonical_url: string;
    retailer_product_id: string | null;
    source_category: string | null;
  }>).map((row) => ({
    id: row.id,
    canonicalUrl: row.canonical_url,
    externalId: row.retailer_product_id,
    sourceCategory: row.source_category,
  }));
}

export function strategyTierNumber(strategy: Strategy): number {
  switch (strategy.tier) {
    case "api":
    case "sitemap":
      return 1;
    case "embedded-json":
    case "dom-crawl":
      return 2;
    case "dom":
      return 3;
    case "script":
      return 4;
  }
}

export function findRetailerExplorationContext(
  database: Database.Database,
  retailerId: string,
  purpose: StrategyPurpose,
): RetailerExplorationContext {
  const retailer = database.prepare(
    `SELECT id, base_url, domains_json
     FROM retailers WHERE id = ?`,
  ).get(retailerId) as {
    id: string;
    base_url: string;
    domains_json: string;
  } | undefined;
  if (retailer === undefined) throw new Error(`Retailer ${retailerId} was not found`);

  const row = database.prepare(
    `SELECT id, retailer_id, purpose, version, strategy_json
     FROM strategies
     WHERE retailer_id = ? AND purpose = ? AND active = 1
     ORDER BY version DESC LIMIT 1`,
  ).get(retailerId, purpose) as ActiveStrategyRow | undefined;
  const previousStrategy = row === undefined
    ? null
    : {
        id: row.id,
        retailerId: row.retailer_id,
        purpose: row.purpose,
        version: row.version,
        strategy: StrategySchema.parse(JSON.parse(row.strategy_json)),
      };
  const domains = JSON.parse(retailer.domains_json) as unknown;
  if (!Array.isArray(domains) || domains.some((domain) => typeof domain !== "string")) {
    throw new Error(`Retailer ${retailerId} has invalid domain evidence`);
  }
  return {
    retailerId: retailer.id,
    baseUrl: retailer.base_url,
    allowedDomains: domains,
    previousStrategy,
  };
}

export function listStrategyValidationRefs(
  database: Database.Database,
  retailerId: string,
  limit = 30,
): ProductRef[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Validation reference limit must be positive");
  }
  return (database.prepare(
    `SELECT canonical_url, retailer_product_id, source_category
     FROM products
     WHERE retailer_id = ? AND active = 1 AND in_scope = 1
     GROUP BY canonical_url
     ORDER BY last_seen DESC, canonical_url
     LIMIT ?`,
  ).all(retailerId, limit) as Array<{
    canonical_url: string;
    retailer_product_id: string | null;
    source_category: string | null;
  }>).map((row) => ({
    canonicalUrl: row.canonical_url,
    externalId: row.retailer_product_id,
    sourceCategory: row.source_category,
  }));
}

export function beginExplorationRun(
  database: Database.Database,
  input: {
    retailerId: string;
    purpose: StrategyPurpose;
    trigger: string;
    previousStrategyId?: string;
    maxAttempts: number;
    startedAt: string;
  },
): string {
  const id = randomUUID();
  database.prepare(
    `INSERT INTO exploration_runs
       (id, retailer_id, purpose, trigger, previous_strategy_id, status,
        event_budget, events_used, sandbox_id, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, 0, ?, ?)`,
  ).run(
    id,
    input.retailerId,
    input.purpose,
    input.trigger,
    input.previousStrategyId ?? null,
    input.maxAttempts,
    randomUUID(),
    input.startedAt,
  );
  return id;
}

export function recordExplorationAttempt(
  database: Database.Database,
  input: ExplorationAttemptEvidence,
): string {
  const id = randomUUID();
  const record = database.transaction(() => {
    const lifecycle = database.prepare(
      `UPDATE exploration_runs
       SET events_used = events_used + 1,
           input_tokens = input_tokens + ?,
           output_tokens = output_tokens + ?,
           cost_usd = cost_usd + ?
       WHERE id = ? AND status = 'running' AND events_used < event_budget`,
    ).run(
      input.inputTokens,
      input.outputTokens,
      input.costUsd,
      input.explorationRunId,
    );
    if (lifecycle.changes !== 1) {
      throw new Error(`Exploration run ${input.explorationRunId} cannot accept another attempt`);
    }
    database.prepare(
      `INSERT INTO exploration_attempts
         (id, exploration_run_id, attempt_number, model, prompt_version,
          prompt_hash, input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, cost_usd, cost_estimated, estimate_source,
          rate_version, external_sample_size, external_successes,
          external_score, outcome, artifact_json, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.explorationRunId,
      input.attemptNumber,
      input.model,
      input.promptVersion,
      input.promptHash,
      input.inputTokens,
      input.cachedInputTokens,
      input.outputTokens,
      input.reasoningOutputTokens,
      input.costUsd,
      input.costEstimated ? 1 : 0,
      input.estimateSource,
      input.rateVersion,
      input.externalSampleSize ?? null,
      input.externalSuccesses ?? null,
      input.externalScore ?? null,
      input.outcome,
      input.artifact === undefined ? null : JSON.stringify(input.artifact),
      input.errorMessage ?? null,
      input.createdAt,
    );
    if (input.inputTokens > 0 || input.outputTokens > 0 || input.costUsd > 0) {
      database.prepare(
        `INSERT INTO cost_ledger
           (id, category, retailer_id, exploration_run_id, provider, model,
            input_tokens, output_tokens, cost_usd, occurred_at, details_json)
         SELECT ?, 'strategy-exploration', retailer_id, id, 'codex-sdk', ?,
                ?, ?, ?, ?, ?
         FROM exploration_runs WHERE id = ?`,
      ).run(
        randomUUID(),
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.costUsd,
        input.createdAt,
        JSON.stringify({
          attemptNumber: input.attemptNumber,
          cachedInputTokens: input.cachedInputTokens,
          reasoningOutputTokens: input.reasoningOutputTokens,
          costEstimated: input.costEstimated,
          estimateSource: input.estimateSource,
          rateVersion: input.rateVersion,
          promptHash: input.promptHash,
        }),
        input.explorationRunId,
      );
    }
  });
  record.immediate();
  return id;
}

export function activateGeneratedStrategy(
  database: Database.Database,
  input: {
    explorationRunId: string;
    retailerId: string;
    purpose: StrategyPurpose;
    expectedPreviousStrategyId?: string;
    strategy: Strategy;
    model: string;
    promptVersion: string;
    validationSampleSize: number;
    validationSuccesses: number;
    validationScore: number;
    activatedAt: string;
  },
): ActivatedStrategy {
  if (input.strategy.purpose !== input.purpose) {
    throw new Error("Generated strategy purpose does not match activation purpose");
  }
  const activate = database.transaction((): ActivatedStrategy => {
    const current = database.prepare(
      `SELECT id FROM strategies
       WHERE retailer_id = ? AND purpose = ? AND active = 1`,
    ).get(input.retailerId, input.purpose) as { id: string } | undefined;
    if ((current?.id ?? undefined) !== input.expectedPreviousStrategyId) {
      throw new Error("Active strategy changed during trusted validation");
    }
    const versionRow = database.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM strategies WHERE retailer_id = ? AND purpose = ?`,
    ).get(input.retailerId, input.purpose) as { version: number };
    const id = randomUUID();
    database.prepare(
      `INSERT INTO strategies
         (id, retailer_id, purpose, tier, version, strategy_json, provenance,
          model, prompt_version, validation_sample_size,
          validation_successes, validation_rate, active, created_at,
          validated_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Codex SDK; trusted host validation', ?, ?,
               ?, ?, ?, 0, ?, ?, NULL)`,
    ).run(
      id,
      input.retailerId,
      input.purpose,
      strategyTierNumber(input.strategy),
      versionRow.version,
      JSON.stringify(input.strategy),
      input.model,
      input.promptVersion,
      input.validationSampleSize,
      input.validationSuccesses,
      input.validationScore,
      input.activatedAt,
      input.activatedAt,
    );
    if (current !== undefined) {
      const retired = database.prepare(
        `UPDATE strategies
         SET active = 0, retired_at = ?
         WHERE id = ? AND active = 1 AND retired_at IS NULL`,
      ).run(input.activatedAt, current.id);
      if (retired.changes !== 1) throw new Error("Previous strategy could not be retired");
    }
    const activated = database.prepare(
      `UPDATE strategies SET active = 1, activated_at = ?
       WHERE id = ? AND active = 0`,
    ).run(input.activatedAt, id);
    if (activated.changes !== 1) throw new Error("Generated strategy could not be activated");
    database.prepare(
      `UPDATE exploration_runs SET candidate_strategy_id = ? WHERE id = ?`,
    ).run(id, input.explorationRunId);
    return { id, version: versionRow.version };
  });
  return activate.immediate();
}

export function finishExplorationRun(
  database: Database.Database,
  input: {
    explorationRunId: string;
    outcome: string;
    finishedAt: string;
    artifact?: unknown;
    errorMessage?: string;
  },
): void {
  const result = database.prepare(
    `UPDATE exploration_runs
     SET status = 'finished', outcome = ?, artifact_json = ?,
         error_message = ?, finished_at = ?
     WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
  ).run(
    input.outcome,
    input.artifact === undefined ? null : JSON.stringify(input.artifact),
    input.errorMessage ?? null,
    input.finishedAt,
    input.explorationRunId,
  );
  if (result.changes !== 1) {
    throw new Error(`Exploration run ${input.explorationRunId} was already finished or missing`);
  }
}

export function insertRunFailure(
  database: Database.Database,
  input: {
    runId: string;
    retailerId: string;
    product?: StoredProductRef;
    canonicalUrl?: string;
    failure: ExtractionFailure;
    occurredAt: string;
    strategyId: string;
    strategyVersion: number;
    replay?: ReplayReference;
  },
): string {
  const id = randomUUID();
  database.prepare(
    `INSERT INTO run_failures
       (id, run_id, retailer_id, product_id, canonical_url, category, message,
        http_status, strategy_id, strategy_version, response_path,
        response_sha256, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.runId,
    input.retailerId,
    input.product?.id ?? null,
    input.canonicalUrl ?? input.product?.canonicalUrl ?? null,
    input.failure.category,
    input.failure.message,
    input.failure.statusCode ?? null,
    input.strategyId,
    input.strategyVersion,
    input.replay?.path ?? null,
    input.replay?.sha256 ?? null,
    input.occurredAt,
  );
  return id;
}

export function insertObservation(
  database: Database.Database,
  input: {
    product: StoredProductRef;
    runId: string;
    result: Extract<ExtractionResult, { ok: boolean }>;
    observedAt: string;
    collectionDay: string;
    strategyId: string;
    strategyVersion: number;
    replay?: ReplayReference;
  },
): string {
  if (input.result.ok !== true || input.result.fields === undefined) {
    throw new Error("A successful extraction result is required");
  }
  const fields = input.result.fields;
  const id = randomUUID();
  const unit = normalizeUnit(fields.unit);
  const transaction = database.transaction(() => {
    database.prepare(
      `UPDATE products
       SET title = ?, brand = ?, raw_unit = ?, quantity_value = ?,
           quantity_unit = ?, base_quantity = ?, base_unit = ?, last_seen = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      fields.title,
      fields.brand,
      unit.raw,
      unit.quantity,
      unit.unit,
      unit.baseQuantity,
      unit.baseUnit,
      input.observedAt,
      input.observedAt,
      input.product.id,
    );
    database.prepare(
      `INSERT INTO observations
         (id, product_id, run_id, strategy_id, strategy_version, observed_at,
          collection_day, title, brand, source_category, raw_unit,
          quantity_value, quantity_unit, base_quantity, base_unit, price_cents,
          promo_price_cents, available, response_path, response_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.product.id,
      input.runId,
      input.strategyId,
      input.strategyVersion,
      input.observedAt,
      input.collectionDay,
      fields.title,
      fields.brand,
      input.product.sourceCategory,
      unit.raw,
      unit.quantity,
      unit.unit,
      unit.baseQuantity,
      unit.baseUnit,
      Math.round(fields.price * 100),
      fields.promoPrice === null ? null : Math.round(fields.promoPrice * 100),
      fields.available ? 1 : 0,
      input.replay?.path ?? null,
      input.replay?.sha256 ?? null,
    );
  });
  transaction.immediate();
  return id;
}

export function activeRetailerIds(database: Database.Database): string[] {
  return (database.prepare(
    "SELECT id FROM retailers WHERE active = 1 ORDER BY id",
  ).all() as Array<{ id: string }>).map((row) => row.id);
}

export function insertHeartbeat(
  database: Database.Database,
  input: {
    pipeline: string;
    scheduledFor: string;
    completedAt: string;
    status: string;
    details: unknown;
  },
): void {
  database.prepare(
    `INSERT INTO heartbeats
       (id, pipeline, scheduled_for, completed_at, status, details_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.pipeline,
    input.scheduledFor,
    input.completedAt,
    input.status,
    JSON.stringify(input.details),
  );
}

export interface StatusReport {
  generatedAt: string;
  staleHeartbeat: boolean;
  retailers: Array<{
    id: string;
    name: string;
    active: boolean;
    degraded: boolean;
    latestRun: null | {
      collectionDay: string;
      attempted: number;
      ok: number;
      failed: number;
      successRate: number;
    };
  }>;
}

interface StatusRow {
  id: string;
  name: string;
  active: number;
  degraded: number;
  collection_day: string | null;
  attempted: number | null;
  ok: number | null;
  failed: number | null;
}

interface HeartbeatRow {
  completed_at: string | null;
}

const HEARTBEAT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export function readStatusReport(
  database: Database.Database,
  now: Date = new Date(),
): StatusReport {
  const rows = database
    .prepare(
      `SELECT
         retailer.id,
         retailer.name,
         retailer.active,
         retailer.degraded,
         latest.collection_day,
         latest.attempted,
         latest.ok,
         latest.failed
       FROM retailers AS retailer
       LEFT JOIN runs AS latest
         ON latest.id = (
           SELECT candidate.id
           FROM runs AS candidate
           WHERE candidate.retailer_id = retailer.id
             AND candidate.stage = 'collect'
           ORDER BY
             candidate.collection_day DESC,
             COALESCE(candidate.finished_at, candidate.started_at) DESC,
             candidate.id DESC
           LIMIT 1
         )
       ORDER BY retailer.name COLLATE NOCASE, retailer.id`,
    )
    .all() as StatusRow[];

  const heartbeat = database
    .prepare(
      `SELECT MAX(completed_at) AS completed_at
       FROM heartbeats
       WHERE pipeline = 'collect' AND status = 'completed'`,
    )
    .get() as HeartbeatRow;
  const completedAt = heartbeat.completed_at === null
    ? Number.NaN
    : Date.parse(heartbeat.completed_at);

  return {
    generatedAt: now.toISOString(),
    staleHeartbeat:
      !Number.isFinite(completedAt) || now.getTime() - completedAt > HEARTBEAT_STALE_AFTER_MS,
    retailers: rows.map((row) => {
      const attempted = row.attempted ?? 0;
      const latestRun = row.collection_day === null
        ? null
        : {
            collectionDay: row.collection_day,
            attempted,
            ok: row.ok ?? 0,
            failed: row.failed ?? 0,
            successRate: attempted === 0 ? 0 : (row.ok ?? 0) / attempted,
          };

      return {
        id: row.id,
        name: row.name,
        active: row.active === 1,
        degraded: row.degraded === 1,
        latestRun,
      };
    }),
  };
}
