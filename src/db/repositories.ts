import type Database from "better-sqlite3";

import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";

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
  FailureCategory,
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

export interface GeneratedStrategyActivationInput {
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
}

export interface StoredRunHealth {
  id: string;
  retailerId: string;
  strategyId: string | null;
  status: string;
  attempted: number;
  ok: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface StoredRunFailureEvidence {
  category: FailureCategory;
  responded: boolean;
  canonicalUrl: string | null;
  message: string | null;
}

export interface HealingEventRecord {
  id: string;
  retailerId: string;
  purpose: StrategyPurpose;
  onsetRunId: string | null;
  previousStrategyId: string | null;
  successorStrategyId: string | null;
  status: string;
  attempts: number;
  tierFrom: number | null;
  tierTo: number | null;
  driftStartedAt: string;
  detectedAt: string;
  recoveredAt: string | null;
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
    healingEventId?: string;
    maxAttempts: number;
    startedAt: string;
  },
): string {
  const id = randomUUID();
  const begin = database.transaction(() => {
    if (input.healingEventId !== undefined) {
      const event = database.prepare(
        `SELECT retailer_id, purpose, previous_strategy_id, status
         FROM healing_events WHERE id = ?`,
      ).get(input.healingEventId) as {
        retailer_id: string;
        purpose: StrategyPurpose;
        previous_strategy_id: string | null;
        status: string;
      } | undefined;
      if (
        event === undefined
        || event.status !== "open"
        || event.retailer_id !== input.retailerId
        || event.purpose !== input.purpose
        || event.previous_strategy_id !== (input.previousStrategyId ?? null)
      ) {
        throw new Error("Healing exploration must bind to its matching open event");
      }
    }
    database.prepare(
      `INSERT INTO exploration_runs
         (id, retailer_id, purpose, trigger, previous_strategy_id,
          healing_event_id, status, event_budget, events_used, sandbox_id,
          started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 0, ?, ?)`,
    ).run(
      id,
      input.retailerId,
      input.purpose,
      input.trigger,
      input.previousStrategyId ?? null,
      input.healingEventId ?? null,
      input.maxAttempts,
      randomUUID(),
      input.startedAt,
    );
  });
  begin.immediate();
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
  input: GeneratedStrategyActivationInput,
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

const FAILURE_CATEGORIES = new Set<FailureCategory>([
  "http-403",
  "http-429",
  "captcha",
  "timeout",
  "network",
  "parse",
  "missing-fields",
  "invalid-price",
  "domain-denied",
  "unknown",
]);

function storedFailureCategory(value: string): FailureCategory {
  return FAILURE_CATEGORIES.has(value as FailureCategory)
    ? value as FailureCategory
    : "unknown";
}

function inferredResponded(category: FailureCategory): boolean {
  return category === "http-403"
    || category === "http-429"
    || category === "captcha"
    || category === "parse"
    || category === "missing-fields"
    || category === "invalid-price";
}

export function findRunHealthEvidence(
  database: Database.Database,
  runId: string,
): { run: StoredRunHealth; failures: StoredRunFailureEvidence[] } {
  const row = database.prepare(
    `SELECT id, retailer_id, strategy_id, status, attempted, ok, failed, started_at,
            finished_at, metadata_json
     FROM runs WHERE id = ? AND stage = 'collect'`,
  ).get(runId) as {
    id: string;
    retailer_id: string | null;
    strategy_id: string | null;
    status: string;
    attempted: number;
    ok: number;
    failed: number;
    started_at: string;
    finished_at: string | null;
    metadata_json: string;
  } | undefined;
  if (row === undefined || row.retailer_id === null) {
    throw new Error(`Collection run ${runId} was not found`);
  }
  let responseHints: boolean[] = [];
  try {
    const metadata = JSON.parse(row.metadata_json) as { failureResponses?: unknown };
    if (
      Array.isArray(metadata.failureResponses)
      && metadata.failureResponses.every((value) => typeof value === "boolean")
    ) {
      responseHints = metadata.failureResponses;
    }
  } catch {
    // Immutable failure categories remain sufficient when old metadata has no hints.
  }
  const failureRows = database.prepare(
    `SELECT category, responded, canonical_url, message
     FROM run_failures WHERE run_id = ?
     ORDER BY occurred_at, id`,
  ).all(runId) as Array<{
    category: string;
    responded: number | null;
    canonical_url: string | null;
    message: string | null;
  }>;
  return {
    run: {
      id: row.id,
      retailerId: row.retailer_id,
      strategyId: row.strategy_id,
      status: row.status,
      attempted: row.attempted,
      ok: row.ok,
      failed: row.failed,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    },
    failures: failureRows.map((failure, index) => {
      const category = storedFailureCategory(failure.category);
      return {
        category,
        responded: failure.responded === null
          ? responseHints[index] ?? inferredResponded(category)
          : failure.responded === 1,
        canonicalUrl: failure.canonical_url,
        message: failure.message,
      };
    }),
  };
}

export function latestTerminalCollectionRunId(
  database: Database.Database,
  retailerId: string,
): string | null {
  const row = database.prepare(
    `SELECT id FROM runs
     WHERE retailer_id = ? AND stage = 'collect'
       AND finished_at IS NOT NULL
       AND status IN ('completed', 'partial', 'failed')
     ORDER BY collection_day DESC, finished_at DESC, id DESC
     LIMIT 1`,
  ).get(retailerId) as { id: string } | undefined;
  return row?.id ?? null;
}

function healingEventFromRow(row: {
  id: string;
  retailer_id: string;
  purpose: StrategyPurpose;
  onset_run_id: string | null;
  previous_strategy_id: string | null;
  successor_strategy_id: string | null;
  status: string;
  attempts: number;
  tier_from: number | null;
  tier_to: number | null;
  drift_started_at: string;
  detected_at: string;
  recovered_at: string | null;
}): HealingEventRecord {
  return {
    id: row.id,
    retailerId: row.retailer_id,
    purpose: row.purpose,
    onsetRunId: row.onset_run_id,
    previousStrategyId: row.previous_strategy_id,
    successorStrategyId: row.successor_strategy_id,
    status: row.status,
    attempts: row.attempts,
    tierFrom: row.tier_from,
    tierTo: row.tier_to,
    driftStartedAt: row.drift_started_at,
    detectedAt: row.detected_at,
    recoveredAt: row.recovered_at,
  };
}

function findHealingEvent(
  database: Database.Database,
  predicate: string,
  ...parameters: unknown[]
): HealingEventRecord | null {
  const row = database.prepare(
    `SELECT id, retailer_id, purpose, onset_run_id, previous_strategy_id,
            successor_strategy_id, status, attempts, tier_from, tier_to,
            drift_started_at, detected_at, recovered_at
     FROM healing_events WHERE ${predicate}
     ORDER BY detected_at DESC, id DESC LIMIT 1`,
  ).get(...parameters) as Parameters<typeof healingEventFromRow>[0] | undefined;
  return row === undefined ? null : healingEventFromRow(row);
}

export function beginHealingEvent(
  database: Database.Database,
  input: {
    retailerId: string;
    purpose: StrategyPurpose;
    onsetRunId: string;
    detectedAt: string;
    queued?: boolean;
  },
): { event: HealingEventRecord; created: boolean } {
  const begin = database.transaction(() => {
    const sameOnset = findHealingEvent(
      database,
      "onset_run_id = ? AND purpose = ?",
      input.onsetRunId,
      input.purpose,
    );
    if (sameOnset !== null) return { event: sameOnset, created: false };
    const open = findHealingEvent(
      database,
      "retailer_id = ? AND purpose = ? AND status = 'open'",
      input.retailerId,
      input.purpose,
    );
    const run = database.prepare(
      `SELECT runs.started_at, runs.strategy_id, strategies.tier,
              strategies.purpose
       FROM runs
       LEFT JOIN strategies ON strategies.id = runs.strategy_id
       WHERE runs.id = ? AND runs.retailer_id = ?`,
    ).get(input.onsetRunId, input.retailerId) as {
      started_at: string;
      strategy_id: string | null;
      tier: number | null;
      purpose: StrategyPurpose | null;
    } | undefined;
    if (run === undefined) throw new Error(`Onset run ${input.onsetRunId} was not found`);
    if (run.strategy_id === null || run.tier === null || run.purpose !== input.purpose) {
      throw new Error(`Onset run ${input.onsetRunId} has no matching strategy evidence`);
    }
    const id = randomUUID();
    database.prepare(
      `INSERT INTO healing_events
         (id, retailer_id, purpose, onset_run_id, previous_strategy_id,
          category, status, attempts, tier_from, drift_started_at,
          detected_at, details_json)
       VALUES (?, ?, ?, ?, ?, 'drift', ?, 0, ?, ?, ?, ?)`,
    ).run(
      id,
      input.retailerId,
      input.purpose,
      input.onsetRunId,
      run.strategy_id,
      open === null ? "open" : "queued",
      run.tier,
      run.started_at,
      input.detectedAt,
      JSON.stringify({
        leaseStartedAt: open !== null || input.queued === true ? null : input.detectedAt,
        ...(open === null ? {} : { blockedByHealingEventId: open.id }),
      }),
    );
    const event = findHealingEvent(database, "id = ?", id);
    if (event === null) throw new Error("Healing event insert was not visible");
    return { event, created: true };
  });
  return begin.immediate();
}

export function listPendingHealingEvents(
  database: Database.Database,
  retailerId?: string,
): HealingEventRecord[] {
  const predicate = retailerId === undefined
    ? "status IN ('open', 'queued')"
    : "status IN ('open', 'queued') AND retailer_id = ?";
  const rows = database.prepare(
    `SELECT id, retailer_id, purpose, onset_run_id, previous_strategy_id,
            successor_strategy_id, status, attempts, tier_from, tier_to,
            drift_started_at, detected_at, recovered_at
     FROM healing_events WHERE ${predicate}
     ORDER BY detected_at, id`,
  ).all(...(retailerId === undefined ? [] : [retailerId])) as Array<
    Parameters<typeof healingEventFromRow>[0]
  >;
  return rows.map(healingEventFromRow);
}

export function promoteQueuedHealingEvent(
  database: Database.Database,
  healingEventId: string,
): boolean {
  const promote = database.transaction(() => {
    const event = findHealingEvent(database, "id = ?", healingEventId);
    if (event === null) throw new Error(`Healing event ${healingEventId} was not found`);
    if (event.status === "open") return true;
    if (event.status !== "queued") return false;
    const open = findHealingEvent(
      database,
      "retailer_id = ? AND purpose = ? AND status = 'open'",
      event.retailerId,
      event.purpose,
    );
    if (open !== null) return false;
    const result = database.prepare(
      `UPDATE healing_events
       SET status = 'open',
           details_json = json_set(details_json, '$.leaseStartedAt', NULL)
       WHERE id = ? AND status = 'queued'`,
    ).run(healingEventId);
    return result.changes === 1;
  });
  return promote.immediate();
}

export function findHealingEventById(
  database: Database.Database,
  healingEventId: string,
): HealingEventRecord | null {
  return findHealingEvent(database, "id = ?", healingEventId);
}

export function recordHealingWorkerError(
  database: Database.Database,
  healingEventId: string,
  errorMessage: string,
): void {
  const result = database.prepare(
    `UPDATE healing_events
     SET details_json = json_set(details_json, '$.workerError', ?)
     WHERE id = ?`,
  ).run(errorMessage, healingEventId);
  if (result.changes !== 1) {
    throw new Error(`Healing event ${healingEventId} was not found`);
  }
}

export interface HealingWorkerFailureResolution {
  event: HealingEventRecord;
  recoveryPending: boolean;
  linkedExplorationRunId?: string;
}

export function finishHealingWorkerFailureIfSafe(
  database: Database.Database,
  input: {
    healingEventId: string;
    errorMessage: string;
    finishedAt: string;
  },
): HealingWorkerFailureResolution {
  const resolve = database.transaction((): HealingWorkerFailureResolution => {
    const event = findHealingEvent(database, "id = ?", input.healingEventId);
    if (event === null) {
      throw new Error(`Healing event ${input.healingEventId} was not found`);
    }
    if (event.status === "queued") {
      return { event, recoveryPending: true };
    }
    if (event.status !== "open") {
      return {
        event,
        recoveryPending: terminalHealingStatus(event.status) === null,
      };
    }

    const linked = database.prepare(
      `SELECT exploration_runs.id, exploration_runs.status,
              model_budget_reservations.status AS reservation_status,
              exploration_recovery_adjustments.id AS adjustment_id
       FROM exploration_runs
       LEFT JOIN model_budget_reservations
         ON model_budget_reservations.exploration_run_id = exploration_runs.id
       LEFT JOIN exploration_recovery_adjustments
         ON exploration_recovery_adjustments.exploration_run_id = exploration_runs.id
       WHERE exploration_runs.healing_event_id = ?
       LIMIT 1`,
    ).get(input.healingEventId) as {
      id: string;
      status: string;
      reservation_status: string | null;
      adjustment_id: string | null;
    } | undefined;
    if (linked !== undefined) {
      return {
        event,
        recoveryPending: true,
        linkedExplorationRunId: linked.id,
      };
    }

    const failed = finishHealingEvent(database, {
      healingEventId: input.healingEventId,
      status: "failed",
      attempts: event.attempts,
      finishedAt: input.finishedAt,
      details: {
        workerError: input.errorMessage,
        recoverySafetyProof: "no-linked-exploration",
      },
    });
    return { event: failed, recoveryPending: false };
  });
  return resolve.immediate();
}

export function claimStaleHealingEvent(
  database: Database.Database,
  healingEventId: string,
  staleBefore: string,
  claimedAt: string,
): boolean {
  const result = database.prepare(
    `UPDATE healing_events
     SET details_json = json_set(details_json, '$.leaseStartedAt', ?)
     WHERE id = ? AND status = 'open'
       AND (
         json_type(details_json, '$.leaseStartedAt') = 'null'
         OR COALESCE(
           json_extract(details_json, '$.leaseStartedAt'),
           detected_at
         ) <= ?
       )`,
  ).run(claimedAt, healingEventId, staleBefore);
  return result.changes === 1;
}

export function finishHealingEvent(
  database: Database.Database,
  input: {
    healingEventId: string;
    status: "recovered" | "failed" | "provider_unavailable" | "deferred" | "superseded";
    attempts: number;
    finishedAt: string;
    successorStrategyId?: string;
    details: unknown;
  },
): HealingEventRecord {
  const finish = database.transaction(() => {
    const event = findHealingEvent(database, "id = ?", input.healingEventId);
    if (event === null) throw new Error(`Healing event ${input.healingEventId} was not found`);
    if (event.status !== "open") return event;
    const tierTo = input.successorStrategyId === undefined
      ? null
      : (database.prepare("SELECT tier FROM strategies WHERE id = ?")
          .get(input.successorStrategyId) as { tier: number } | undefined)?.tier ?? null;
    const recoveredAt = input.status === "recovered" ? input.finishedAt : null;
    const startMs = Date.parse(event.driftStartedAt);
    const finishMs = Date.parse(input.finishedAt);
    const durationSeconds = Number.isFinite(startMs) && Number.isFinite(finishMs)
      ? Math.max(0, Math.floor((finishMs - startMs) / 1_000))
      : null;
    const result = database.prepare(
      `UPDATE healing_events
       SET successor_strategy_id = ?, status = ?, attempts = ?, tier_to = ?,
           recovered_at = ?, duration_seconds = ?, details_json = ?
       WHERE id = ? AND status = 'open'`,
    ).run(
      input.successorStrategyId ?? null,
      input.status,
      input.attempts,
      tierTo,
      recoveredAt,
      durationSeconds,
      JSON.stringify(input.details),
      input.healingEventId,
    );
    if (result.changes !== 1) throw new Error("Healing event lifecycle update failed");
    const completed = findHealingEvent(database, "id = ?", input.healingEventId);
    if (completed === null) throw new Error("Healing event completion was not visible");
    return completed;
  });
  return finish.immediate();
}

export interface ReconciledHealingExploration {
  explorationRunId: string;
  outcome: string;
  status: "recovered" | "failed" | "provider_unavailable" | "deferred" | "superseded";
  attempts: number;
  costUsd: number;
}

function reconciliationHealingStatus(
  outcome: string,
): "failed" | "provider_unavailable" | "deferred" {
  if (outcome === "provider_unavailable") return "provider_unavailable";
  if (
    outcome === "budget_paused"
    || outcome === "budget_exhausted"
    || outcome === "insufficient_samples"
    || outcome === "recovery_zero_attempt"
  ) return "deferred";
  return "failed";
}

function terminalHealingStatus(
  status: string,
): ReconciledHealingExploration["status"] | null {
  return status === "recovered"
    || status === "failed"
    || status === "provider_unavailable"
    || status === "deferred"
    || status === "superseded"
    ? status
    : null;
}

export function reconcileHealingExploration(
  database: Database.Database,
  input: { healingEventId: string; finishedAt: string },
): ReconciledHealingExploration | null {
  const reconcile = database.transaction((): ReconciledHealingExploration | null => {
    const event = findHealingEvent(database, "id = ?", input.healingEventId);
    if (event === null) throw new Error(`Healing event ${input.healingEventId} was not found`);
    const run = database.prepare(
      `SELECT id, retailer_id, purpose, status, outcome, events_used,
              input_tokens, output_tokens, cost_usd
       FROM exploration_runs WHERE healing_event_id = ?`,
    ).get(input.healingEventId) as {
      id: string;
      retailer_id: string;
      purpose: StrategyPurpose;
      status: string;
      outcome: string | null;
      events_used: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    } | undefined;
    if (run === undefined) return null;
    if (run.retailer_id !== event.retailerId || run.purpose !== event.purpose) {
      throw new Error("Healing exploration identity does not match its event");
    }

    const attempts = database.prepare(
      `SELECT attempt_number, outcome, input_tokens, cached_input_tokens,
              output_tokens, reasoning_output_tokens, cost_usd, error_message
       FROM exploration_attempts
       WHERE exploration_run_id = ?
       ORDER BY attempt_number`,
    ).all(run.id) as Array<{
      attempt_number: number;
      outcome: string;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
      cost_usd: number;
      error_message: string | null;
    }>;
    const ledger = database.prepare(
      `SELECT id, category, provider, model, input_tokens, output_tokens,
              cost_usd
       FROM cost_ledger WHERE exploration_run_id = ?
       ORDER BY occurred_at, id`,
    ).all(run.id) as Array<{
      id: string;
      category: string;
      provider: string;
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>;
    const adjustment = database.prepare(
      `SELECT a.id, a.cost_ledger_id, a.reserved_amount_usd, a.amount_usd,
              l.id AS linked_ledger_id,
              l.exploration_run_id AS ledger_exploration_run_id,
              l.category AS ledger_category, l.provider AS ledger_provider,
              l.model AS ledger_model, l.input_tokens AS ledger_input_tokens,
              l.output_tokens AS ledger_output_tokens,
              l.cost_usd AS ledger_cost_usd,
              json_extract(l.details_json, '$.recoveryAdjustmentId')
                AS details_adjustment_id
       FROM exploration_recovery_adjustments AS a
       LEFT JOIN cost_ledger AS l ON l.id = a.cost_ledger_id
       WHERE a.exploration_run_id = ?`,
    ).get(run.id) as {
      id: string;
      cost_ledger_id: string;
      reserved_amount_usd: number;
      amount_usd: number;
      linked_ledger_id: string | null;
      ledger_exploration_run_id: string | null;
      ledger_category: string | null;
      ledger_provider: string | null;
      ledger_model: string | null;
      ledger_input_tokens: number | null;
      ledger_output_tokens: number | null;
      ledger_cost_usd: number | null;
      details_adjustment_id: string | null;
    } | undefined;
    const attemptInputTokens = attempts.reduce((sum, row) => sum + row.input_tokens, 0);
    const attemptOutputTokens = attempts.reduce((sum, row) => sum + row.output_tokens, 0);
    const attemptHasUsage = attempts.some((row) =>
      row.input_tokens > 0
      || row.cached_input_tokens > 0
      || row.output_tokens > 0
      || row.reasoning_output_tokens > 0
    );
    const attemptCost = attempts.reduce(
      (sum, row) => sum.plus(row.cost_usd),
      new Decimal(0),
    ).toDecimalPlaces(12);
    let recoveryAdjustment = new Decimal(adjustment?.amount_usd ?? 0).toDecimalPlaces(12);
    const evidenceCost = attemptCost.plus(recoveryAdjustment).toDecimalPlaces(12);
    const ledgerInputTokens = ledger.reduce((sum, row) => sum + row.input_tokens, 0);
    const ledgerOutputTokens = ledger.reduce((sum, row) => sum + row.output_tokens, 0);
    const ledgerCost = ledger.reduce(
      (sum, row) => sum.plus(row.cost_usd),
      new Decimal(0),
    ).toDecimalPlaces(12);
    const recoveryLedger = ledger.filter(
      ({ category }) => category === "strategy-exploration-recovery",
    );
    const adjustmentLinkDisagrees = adjustment === undefined
      ? recoveryLedger.length !== 0
      : recoveryLedger.length !== 1
        || adjustment.linked_ledger_id !== adjustment.cost_ledger_id
        || adjustment.ledger_exploration_run_id !== run.id
        || adjustment.ledger_category !== "strategy-exploration-recovery"
        || adjustment.ledger_provider !== "internal-recovery"
        || adjustment.ledger_model !== null
        || adjustment.ledger_input_tokens !== 0
        || adjustment.ledger_output_tokens !== 0
        || adjustment.details_adjustment_id !== adjustment.id
        || !new Decimal(adjustment.ledger_cost_usd ?? -1)
          .toDecimalPlaces(12).equals(recoveryAdjustment);
    if (
      run.events_used !== attempts.length
      || run.input_tokens !== attemptInputTokens
      || run.output_tokens !== attemptOutputTokens
      || !new Decimal(run.cost_usd).toDecimalPlaces(12).equals(evidenceCost)
      || ledgerInputTokens !== attemptInputTokens
      || ledgerOutputTokens !== attemptOutputTokens
      || !ledgerCost.equals(evidenceCost)
      || adjustmentLinkDisagrees
    ) {
      throw new Error(
        "Healing exploration attempt, adjustment, run, and cost-ledger evidence disagree",
      );
    }

    const lastAttempt = attempts.at(-1);
    const outcome = run.status === "finished" && run.outcome !== null
      ? run.outcome
      : lastAttempt?.outcome ?? "recovery_zero_attempt";
    const existingTerminalStatus = terminalHealingStatus(event.status);
    const reservation = database.prepare(
      `SELECT amount_usd, status, actual_cost_usd
       FROM model_budget_reservations WHERE exploration_run_id = ?`,
    ).get(run.id) as {
      amount_usd: number;
      status: string;
      actual_cost_usd: number;
    } | undefined;
    if (reservation === undefined) {
      if (attemptHasUsage || adjustment !== undefined || !evidenceCost.isZero()) {
        throw new Error("Healing exploration paid evidence has no budget reservation");
      }
    } else if (adjustment !== undefined) {
      const expectedAdjustment = Decimal.max(
        new Decimal(reservation.amount_usd).minus(attemptCost),
        0,
      ).toDecimalPlaces(12);
      if (
        !new Decimal(adjustment.reserved_amount_usd).toDecimalPlaces(12)
          .equals(new Decimal(reservation.amount_usd).toDecimalPlaces(12))
        || !recoveryAdjustment.equals(expectedAdjustment)
      ) {
        throw new Error("Healing exploration recovery adjustment disagrees with its reservation");
      }
    }

    if (reservation?.status === "reserved" && adjustment === undefined) {
      if (existingTerminalStatus !== null || event.status !== "open" || run.status !== "running") {
        throw new Error("Active healing reservation cannot adjust terminal lifecycle evidence");
      }
      recoveryAdjustment = Decimal.max(
        new Decimal(reservation.amount_usd).minus(attemptCost),
        0,
      ).toDecimalPlaces(12);
      const adjustmentId = randomUUID();
      const costLedgerId = randomUUID();
      const adjustmentCostUsd = recoveryAdjustment.toNumber();
      const details = {
        recoveryAdjustmentId: adjustmentId,
        reason: "interrupted-healing-active-reservation",
        reservedAmountUsd: reservation.amount_usd,
        attemptCostUsd: attemptCost.toNumber(),
        unaccountedRemainderUsd: adjustmentCostUsd,
      };
      database.prepare(
        `INSERT INTO cost_ledger
           (id, category, retailer_id, exploration_run_id, provider, model,
            input_tokens, output_tokens, cost_usd, occurred_at, details_json)
         VALUES (?, 'strategy-exploration-recovery', ?, ?,
                 'internal-recovery', NULL, 0, 0, ?, ?, ?)`,
      ).run(
        costLedgerId,
        run.retailer_id,
        run.id,
        adjustmentCostUsd,
        input.finishedAt,
        JSON.stringify(details),
      );
      database.prepare(
        `INSERT INTO exploration_recovery_adjustments
           (id, exploration_run_id, cost_ledger_id, reserved_amount_usd,
            amount_usd, created_at, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        adjustmentId,
        run.id,
        costLedgerId,
        reservation.amount_usd,
        adjustmentCostUsd,
        input.finishedAt,
        JSON.stringify(details),
      );
      const totalCost = attemptCost.plus(recoveryAdjustment).toDecimalPlaces(12);
      const updated = database.prepare(
        `UPDATE exploration_runs SET cost_usd = ?
         WHERE id = ? AND status = 'running'`,
      ).run(totalCost.toNumber(), run.id);
      if (updated.changes !== 1) {
        throw new Error("Healing exploration recovery cost could not update its running run");
      }
    }

    const totalCost = attemptCost.plus(recoveryAdjustment).toDecimalPlaces(12);
    const costUsd = totalCost.toNumber();
    if (
      reservation !== undefined
      && reservation.status !== "reserved"
      && !new Decimal(reservation.actual_cost_usd).toDecimalPlaces(12).equals(totalCost)
    ) {
      throw new Error("Healing exploration reservation disagrees with immutable cost evidence");
    }
    if (existingTerminalStatus !== null) {
      return {
        explorationRunId: run.id,
        outcome,
        status: existingTerminalStatus,
        attempts: attempts.length,
        costUsd,
      };
    }
    if (event.status !== "open") {
      throw new Error("Associated healing exploration cannot reconcile a non-open event");
    }
    if (run.status === "running") {
      finishExplorationRun(database, {
        explorationRunId: run.id,
        outcome,
        finishedAt: input.finishedAt,
        artifact: {
          reconciled: true,
          attempts: attempts.length,
          attemptCostUsd: attemptCost.toNumber(),
          recoveryAdjustmentUsd: recoveryAdjustment.toNumber(),
          costUsd,
          source: "immutable-attempt-adjustment-and-cost-ledger-evidence",
        },
        errorMessage: lastAttempt?.error_message
          ?? (attempts.length === 0
            ? "Healing exploration stopped before the first model attempt"
            : "Healing exploration terminal bundle was recovered after worker interruption"),
      });
    } else if (run.status !== "finished") {
      throw new Error(`Healing exploration ${run.id} has an unknown lifecycle status`);
    }

    if (reservation?.status === "reserved") {
      const settled = database.prepare(
        `UPDATE model_budget_reservations
         SET status = 'settled', actual_cost_usd = ?, settled_at = ?,
             details_json = json_set(
               details_json,
               '$.actualCostUsd', ?,
               '$.reconciled', json('true'),
               '$.attemptCostUsd', ?,
               '$.recoveryAdjustmentUsd', ?
             )
         WHERE exploration_run_id = ? AND status = 'reserved'`,
      ).run(
        costUsd,
        input.finishedAt,
        costUsd,
        attemptCost.toNumber(),
        recoveryAdjustment.toNumber(),
        run.id,
      );
      if (settled.changes !== 1) {
        throw new Error("Healing exploration reservation changed during reconciliation");
      }
    }

    const finalRun = database.prepare(
      `SELECT cost_usd FROM exploration_runs WHERE id = ? AND status = 'finished'`,
    ).get(run.id) as { cost_usd: number } | undefined;
    const finalLedger = database.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM cost_ledger WHERE exploration_run_id = ?`,
    ).get(run.id) as { cost_usd: number };
    const finalReservation = database.prepare(
      `SELECT status, actual_cost_usd
       FROM model_budget_reservations WHERE exploration_run_id = ?`,
    ).get(run.id) as { status: string; actual_cost_usd: number } | undefined;
    if (
      finalRun === undefined
      || !new Decimal(finalRun.cost_usd).toDecimalPlaces(12).equals(totalCost)
      || !new Decimal(finalLedger.cost_usd).toDecimalPlaces(12).equals(totalCost)
      || (
        finalReservation !== undefined
        && (
          finalReservation.status !== "settled"
          || !new Decimal(finalReservation.actual_cost_usd).toDecimalPlaces(12)
            .equals(totalCost)
        )
      )
    ) {
      throw new Error("Healing exploration reconciliation bundle failed its cost proof");
    }

    const healingStatus = reconciliationHealingStatus(outcome);
    finishHealingEvent(database, {
      healingEventId: input.healingEventId,
      status: healingStatus,
      attempts: attempts.length,
      finishedAt: input.finishedAt,
      details: {
        reconciled: true,
        explorationRunId: run.id,
        explorationOutcome: outcome,
        attemptCostUsd: attemptCost.toNumber(),
        recoveryAdjustmentUsd: recoveryAdjustment.toNumber(),
        costUsd,
        evidenceSource: "immutable-attempt-adjustment-and-cost-ledger-evidence",
      },
    });
    return {
      explorationRunId: run.id,
      outcome,
      status: healingStatus,
      attempts: attempts.length,
      costUsd,
    };
  });
  return reconcile.immediate();
}

export function commitExplorationSuccess(
  database: Database.Database,
  input: {
    attempt: ExplorationAttemptEvidence;
    activation: GeneratedStrategyActivationInput;
    exploration: {
      outcome: string;
      finishedAt: string;
      artifact: unknown;
    };
    totalAttempts: number;
    totalCostUsd: number;
    healingEventId?: string;
  },
): ActivatedStrategy {
  const commit = database.transaction(() => {
    if (input.healingEventId !== undefined) {
      const event = findHealingEvent(database, "id = ?", input.healingEventId);
      if (
        event === null
        || event.status !== "open"
        || event.previousStrategyId !== input.activation.expectedPreviousStrategyId
      ) {
        throw new Error("Healing event changed before trusted activation");
      }
    }
    recordExplorationAttempt(database, input.attempt);
    const activated = activateGeneratedStrategy(database, input.activation);
    finishExplorationRun(database, {
      explorationRunId: input.activation.explorationRunId,
      outcome: input.exploration.outcome,
      finishedAt: input.exploration.finishedAt,
      artifact: input.exploration.artifact,
    });
    if (input.healingEventId !== undefined) {
      finishHealingEvent(database, {
        healingEventId: input.healingEventId,
        status: "recovered",
        attempts: input.totalAttempts,
        finishedAt: input.exploration.finishedAt,
        successorStrategyId: activated.id,
        details: {
          explorationRunId: input.activation.explorationRunId,
          explorationOutcome: input.exploration.outcome,
          externalScore: input.activation.validationScore,
          costUsd: input.totalCostUsd,
        },
      });
      setRetailerDegraded(
        database,
        input.activation.retailerId,
        false,
        undefined,
        input.exploration.finishedAt,
      );
    }
    const reservation = database.prepare(
      `UPDATE model_budget_reservations
       SET status = 'settled', actual_cost_usd = ?, settled_at = ?,
           details_json = json_set(details_json, '$.actualCostUsd', ?)
       WHERE exploration_run_id = ? AND status = 'reserved'`,
    ).run(
      input.totalCostUsd,
      input.exploration.finishedAt,
      input.totalCostUsd,
      input.activation.explorationRunId,
    );
    if (reservation.changes !== 1) {
      throw new Error("Exploration success requires an active budget reservation");
    }
    return activated;
  });
  return commit.immediate();
}

export function commitExplorationTerminal(
  database: Database.Database,
  input: {
    explorationRunId: string;
    outcome: string;
    finishedAt: string;
    artifact: unknown;
    errorMessage?: string;
    totalAttempts: number;
    totalCostUsd: number;
    reservationActive: boolean;
    healingEventId: string;
    healingStatus: "failed" | "provider_unavailable" | "deferred";
    healingDetails: unknown;
  },
): void {
  const commit = database.transaction(() => {
    const event = findHealingEvent(database, "id = ?", input.healingEventId);
    if (event === null || event.status !== "open") {
      throw new Error("Healing event changed before exploration finalization");
    }
    finishExplorationRun(database, {
      explorationRunId: input.explorationRunId,
      outcome: input.outcome,
      finishedAt: input.finishedAt,
      artifact: input.artifact,
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    });
    if (input.reservationActive) {
      const reservation = database.prepare(
        `UPDATE model_budget_reservations
         SET status = ?, actual_cost_usd = ?, settled_at = ?,
             details_json = json_set(details_json, '$.actualCostUsd', ?)
         WHERE exploration_run_id = ? AND status = 'reserved'`,
      ).run(
        input.totalCostUsd === 0 ? "released" : "settled",
        input.totalCostUsd,
        input.finishedAt,
        input.totalCostUsd,
        input.explorationRunId,
      );
      if (reservation.changes !== 1) {
        throw new Error("Terminal exploration requires its active budget reservation");
      }
    }
    finishHealingEvent(database, {
      healingEventId: input.healingEventId,
      status: input.healingStatus,
      attempts: input.totalAttempts,
      finishedAt: input.finishedAt,
      details: input.healingDetails,
    });
  });
  commit.immediate();
}

export function consecutiveFailedHealingEvents(
  database: Database.Database,
  retailerId: string,
  purpose: StrategyPurpose,
): number {
  const statuses = database.prepare(
    `SELECT status FROM healing_events
     WHERE retailer_id = ? AND purpose = ?
     ORDER BY rowid DESC
     LIMIT 20`,
  ).all(retailerId, purpose) as Array<{ status: string }>;
  let count = 0;
  for (const { status } of statuses) {
    if (status !== "failed") break;
    count += 1;
  }
  return count;
}

export function setRetailerDegraded(
  database: Database.Database,
  retailerId: string,
  degraded: boolean,
  reason?: string,
  updatedAt = new Date().toISOString(),
): void {
  const result = database.prepare(
    `UPDATE retailers
     SET degraded = ?, degraded_reason = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    degraded ? 1 : 0,
    degraded ? reason ?? "strategy regeneration failed" : null,
    updatedAt,
    retailerId,
  );
  if (result.changes !== 1) throw new Error(`Retailer ${retailerId} was not found`);
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
        response_sha256, occurred_at, responded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.failure.responded ? 1 : 0,
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
