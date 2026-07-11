import type Database from "better-sqlite3";

import { randomUUID, type KeyObject } from "node:crypto";
import { Decimal } from "decimal.js";

import type { CatalogScopeDecision } from "../catalog/scope.js";
import { normalizeUnit } from "../normalize/unit.js";
import { isDescriptiveProductTitle } from "../normalize/title.js";
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
import { selectStrategyValidationChallenge } from "../strategies/validation-challenge.js";
import {
  canonicalEvidenceJson,
  readTrustedValidatorArtifactSha256,
  readValidationVerificationPublicKey,
  strategyEvidenceSha256,
  validateStrategyEvidence,
  validationReceiptSha256,
  type StrategyValidationEvidence,
} from "../strategies/validation-evidence.js";
import { insertVerifiedStrategyValidationEvidence } from "./database.js";

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

export interface RunFinalizationMetadata {
  planned?: number;
  skipped?: number;
  stoppedForBlocking?: boolean;
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
  nextStrategyVersion: number;
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
  validationEvidence: {
    receiptPath: string;
    receiptSha256: string;
    evidence: StrategyValidationEvidence;
    testVerificationPublicKey?: KeyObject;
  };
  activatedAt: string;
}

export interface StoredRunHealth {
  id: string;
  retailerId: string;
  stage: "discover" | "collect";
  purpose: StrategyPurpose;
  strategyId: string | null;
  collectionDay: string;
  status: string;
  attempted: number;
  ok: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  planned: number | null;
  skipped: number;
  stoppedForBlocking: boolean;
}

export interface StoredRunFailureEvidence {
  category: FailureCategory;
  responded: boolean;
  canonicalUrl: string | null;
  message: string | null;
  replay: ReplayReference | null;
}

export interface SuccessfulReplayEvidence {
  canonicalUrl: string;
  collectionDay: string;
  replay: ReplayReference;
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

export function attemptedForStageOnDay(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
  stage: "discover" | "collect",
): number {
  const row = database.prepare(
    `SELECT COALESCE(SUM(attempted), 0) AS attempted
     FROM runs
     WHERE retailer_id = ? AND collection_day = ? AND stage = ?`,
  ).get(retailerId, collectionDay, stage) as { attempted: number };
  return row.attempted;
}

export type RequestAdmissionStage = "discover" | "collect";

export const DAILY_NETWORK_REQUEST_BUDGET = 2_000;
export const REQUEST_BUDGET_BY_STAGE: Readonly<Record<RequestAdmissionStage, number>> = {
  discover: DAILY_NETWORK_REQUEST_BUDGET,
  collect: DAILY_NETWORK_REQUEST_BUDGET,
};

export interface RequestAdmissionResult {
  admitted: boolean;
  used: number;
  remaining: number;
  admissionId: string | null;
}

export function requestAdmissionsForStageOnDay(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
  stage: RequestAdmissionStage,
): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS admitted
    FROM request_admissions
    WHERE retailer_id = ? AND collection_day = ? AND stage = ?
  `).get(retailerId, collectionDay, stage) as { admitted: number };
  return row.admitted;
}

export function requestAdmissionsForDay(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
): number {
  return (database.prepare(`
    SELECT COUNT(*) AS admitted
    FROM request_admissions
    WHERE retailer_id = ? AND collection_day = ?
  `).get(retailerId, collectionDay) as { admitted: number }).admitted;
}

export function remainingRequestAdmissions(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
  _stage: RequestAdmissionStage,
): number {
  return Math.max(
    0,
    DAILY_NETWORK_REQUEST_BUDGET
      - requestAdmissionsForDay(database, retailerId, collectionDay),
  );
}

/**
 * Durably charges one request before network execution. BEGIN IMMEDIATE makes
 * the count-and-insert gate atomic across processes; the append-only row is not
 * rolled back with later run work, so a crash still consumes the admission.
 */
export function admitRequest(
  database: Database.Database,
  input: {
    runId: string;
    retailerId: string;
    collectionDay: string;
    stage: RequestAdmissionStage;
    admittedAt: string;
    id?: string;
  },
): RequestAdmissionResult {
  const admit = database.transaction((): RequestAdmissionResult => {
    const run = database.prepare(`
      SELECT retailer_id AS retailerId, collection_day AS collectionDay, stage,
             status, finished_at AS finishedAt
      FROM runs WHERE id = ?
    `).get(input.runId) as {
      retailerId: string;
      collectionDay: string;
      stage: RequestAdmissionStage;
      status: string;
      finishedAt: string | null;
    } | undefined;
    if (
      run === undefined
      || run.retailerId !== input.retailerId
      || run.collectionDay !== input.collectionDay
      || run.stage !== input.stage
      || run.status !== "running"
      || run.finishedAt !== null
    ) {
      throw new Error("Request admission identity must match an existing run");
    }
    const used = requestAdmissionsForDay(
      database,
      input.retailerId,
      input.collectionDay,
    );
    const maximum = DAILY_NETWORK_REQUEST_BUDGET;
    if (used >= maximum) {
      return { admitted: false, used, remaining: 0, admissionId: null };
    }
    const stageOrdinal = requestAdmissionsForStageOnDay(
      database,
      input.retailerId,
      input.collectionDay,
      input.stage,
    ) + 1;
    const admissionId = input.id ?? randomUUID();
    database.prepare(`
      INSERT INTO request_admissions
        (id, run_id, retailer_id, collection_day, stage, stage_ordinal, admitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      admissionId,
      input.runId,
      input.retailerId,
      input.collectionDay,
      input.stage,
      stageOrdinal,
      input.admittedAt,
    );
    return {
      admitted: true,
      used: used + 1,
      remaining: maximum - used - 1,
      admissionId,
    };
  });
  return admit.immediate();
}

export const DISCOVERY_REFERENCE_BUDGET = 3_000;

export function discoveryReferenceAdmissionsForDay(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
): number {
  return (database.prepare(`
    SELECT COUNT(*) AS admitted
    FROM discovery_reference_admissions
    WHERE retailer_id = ? AND collection_day = ?
  `).get(retailerId, collectionDay) as { admitted: number }).admitted;
}

export function remainingDiscoveryReferenceAdmissions(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
): number {
  return Math.max(
    0,
    DISCOVERY_REFERENCE_BUDGET
      - discoveryReferenceAdmissionsForDay(database, retailerId, collectionDay),
  );
}

/** Durably charges one yielded discovery reference before product persistence. */
export function admitDiscoveryReference(
  database: Database.Database,
  input: {
    runId: string;
    retailerId: string;
    collectionDay: string;
    canonicalUrl: string | null;
    admittedAt: string;
    id?: string;
  },
): RequestAdmissionResult {
  return database.transaction((): RequestAdmissionResult => {
    const run = database.prepare(`
      SELECT retailer_id AS retailerId, collection_day AS collectionDay, stage,
             status, finished_at AS finishedAt
      FROM runs WHERE id = ?
    `).get(input.runId) as {
      retailerId: string;
      collectionDay: string;
      stage: string;
      status: string;
      finishedAt: string | null;
    } | undefined;
    if (
      run === undefined
      || run.retailerId !== input.retailerId
      || run.collectionDay !== input.collectionDay
      || run.stage !== "discover"
      || run.status !== "running"
      || run.finishedAt !== null
    ) {
      throw new Error("Discovery reference admission must match an existing run");
    }
    const used = discoveryReferenceAdmissionsForDay(
      database,
      input.retailerId,
      input.collectionDay,
    );
    if (used >= DISCOVERY_REFERENCE_BUDGET) {
      return { admitted: false, used, remaining: 0, admissionId: null };
    }
    const admissionId = input.id ?? randomUUID();
    database.prepare(`
      INSERT INTO discovery_reference_admissions
        (id, run_id, retailer_id, collection_day, day_ordinal,
         canonical_url, admitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      admissionId,
      input.runId,
      input.retailerId,
      input.collectionDay,
      used + 1,
      input.canonicalUrl,
      input.admittedAt,
    );
    return {
      admitted: true,
      used: used + 1,
      remaining: DISCOVERY_REFERENCE_BUDGET - used - 1,
      admissionId,
    };
  }).immediate();
}

export const DAILY_REPLAY_ADMISSION_BUDGET = 20;

export function replaySlotAdmissionsForDay(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
): number {
  return (database.prepare(`
    SELECT COUNT(*) AS admitted
    FROM replay_slot_admissions
    WHERE retailer_id = ? AND collection_day = ?
  `).get(retailerId, collectionDay) as { admitted: number }).admitted;
}

export function remainingReplaySlotAdmissions(
  database: Database.Database,
  retailerId: string,
  collectionDay: string,
): number {
  return Math.max(
    0,
    DAILY_REPLAY_ADMISSION_BUDGET
      - replaySlotAdmissionsForDay(database, retailerId, collectionDay),
  );
}

/** Durably charges one replay sample immediately before payload file I/O. */
export function admitReplaySlot(
  database: Database.Database,
  input: {
    runId: string;
    retailerId: string;
    productId: string;
    collectionDay: string;
    admittedAt: string;
    id?: string;
  },
): RequestAdmissionResult {
  return database.transaction((): RequestAdmissionResult => {
    const identity = database.prepare(`
      SELECT 1
      FROM runs
      JOIN products ON products.id = ?
      WHERE runs.id = ?
        AND runs.retailer_id = ?
        AND runs.collection_day = ?
        AND runs.stage = 'collect'
        AND runs.status = 'running'
        AND runs.finished_at IS NULL
        AND products.retailer_id = runs.retailer_id
    `).get(
      input.productId,
      input.runId,
      input.retailerId,
      input.collectionDay,
    );
    if (identity === undefined) {
      throw new Error("Replay slot admission must match an existing run and product");
    }
    const used = replaySlotAdmissionsForDay(
      database,
      input.retailerId,
      input.collectionDay,
    );
    if (used >= DAILY_REPLAY_ADMISSION_BUDGET) {
      return { admitted: false, used, remaining: 0, admissionId: null };
    }
    const admissionId = input.id ?? randomUUID();
    database.prepare(`
      INSERT INTO replay_slot_admissions
        (id, run_id, retailer_id, product_id, collection_day,
         day_ordinal, admitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      admissionId,
      input.runId,
      input.retailerId,
      input.productId,
      input.collectionDay,
      used + 1,
      input.admittedAt,
    );
    return {
      admitted: true,
      used: used + 1,
      remaining: DAILY_REPLAY_ADMISSION_BUDGET - used - 1,
      admissionId,
    };
  }).immediate();
}

/** Aggregate compatibility helper for status/reporting callers. Network safety
 * caps use the durable request_admissions ledger above, not mutable/finalized
 * run counters. */
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
  metadata?: RunFinalizationMetadata,
): void {
  if (counters.attempted !== counters.ok + counters.failed) {
    throw new Error("Run counters must satisfy attempted = ok + failed");
  }
  const metadataPatch: RunFinalizationMetadata = {};
  if (metadata?.planned !== undefined) {
    if (!Number.isSafeInteger(metadata.planned) || metadata.planned < 0) {
      throw new Error("Run planned count must be a non-negative safe integer");
    }
    metadataPatch.planned = metadata.planned;
  }
  if (metadata?.skipped !== undefined) {
    if (!Number.isSafeInteger(metadata.skipped) || metadata.skipped < 0) {
      throw new Error("Run skipped count must be a non-negative safe integer");
    }
    metadataPatch.skipped = metadata.skipped;
  }
  if (
    (metadataPatch.planned === undefined) !== (metadataPatch.skipped === undefined)
  ) {
    throw new Error("Run planned and skipped counts must be finalized together");
  }
  if (
    metadataPatch.planned !== undefined
    && metadataPatch.skipped !== undefined
    && metadataPatch.planned !== counters.attempted + metadataPatch.skipped
  ) {
    throw new Error("Run planned count must equal attempted plus skipped");
  }
  if (metadata?.stoppedForBlocking !== undefined) {
    if (typeof metadata.stoppedForBlocking !== "boolean") {
      throw new Error("Run blocking-stop fact must be boolean");
    }
    metadataPatch.stoppedForBlocking = metadata.stoppedForBlocking;
  }
  if (
    metadataPatch.stoppedForBlocking === true
    && (
      metadataPatch.planned === undefined
      || metadataPatch.skipped === undefined
    )
  ) {
    throw new Error("Blocking detection requires finalized planned and skipped counts");
  }
  const result = database.prepare(
    `UPDATE runs
     SET status = ?, attempted = ?, ok = ?, failed = ?, finished_at = ?,
         error_category = ?, error_message = ?,
         metadata_json = json_patch(metadata_json, ?)
     WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
  ).run(
    status,
    counters.attempted,
    counters.ok,
    counters.failed,
    finishedAt,
    error?.category ?? null,
    error?.message ?? null,
    JSON.stringify(metadataPatch),
    runId,
  );
  if (result.changes !== 1) throw new Error(`Run ${runId} was already finalized or missing`);
}

function productTitle(ref: ProductRef): string {
  try {
    const technicalSegments = new Set(["item", "p", "pd", "product", "produto"]);
    const segments = new URL(ref.canonicalUrl).pathname.split("/").filter(Boolean);
    for (const segment of segments.reverse()) {
      const decoded = decodeURIComponent(segment).trim();
      if (technicalSegments.has(decoded.toLocaleLowerCase("pt-BR"))) continue;
      const humanized = decoded
        .replace(/[-_]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      if (humanized.length > 0 && !/^\d+$/u.test(humanized)) return humanized;
    }
  } catch {
    // The strategy layer normally canonicalizes URLs; retain a safe fallback for evidence.
  }
  return "Produto aguardando observação descritiva";
}

export function upsertDiscoveredProduct(
  database: Database.Database,
  retailerId: string,
  ref: ProductRef,
  seenAt: string,
  evidence?: {
    runId: string;
    scope: CatalogScopeDecision;
  },
): StoredProductRef {
  let row!: {
    id: string;
    canonical_url: string;
    retailer_product_id: string | null;
    source_category: string | null;
  };
  const upsert = database.transaction(() => {
    if (evidence !== undefined) {
      const run = database.prepare(`
        SELECT 1 FROM runs
        WHERE id = ? AND retailer_id = ? AND stage = 'discover'
          AND status = 'running' AND finished_at IS NULL
      `).get(evidence.runId, retailerId);
      if (run === undefined) {
        throw new Error("Product scope evidence must match a running discovery run");
      }
    }
    database.prepare(
      `INSERT INTO products
         (id, retailer_id, canonical_url, retailer_product_id, title,
          source_category, in_scope, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (retailer_id, canonical_url) DO UPDATE SET
         retailer_product_id = COALESCE(excluded.retailer_product_id, products.retailer_product_id),
         source_category = COALESCE(excluded.source_category, products.source_category),
         in_scope = excluded.in_scope,
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
      evidence?.scope.inScope === false ? 0 : 1,
      seenAt,
      seenAt,
    );
    row = database.prepare(
      `SELECT id, canonical_url, retailer_product_id, source_category
       FROM products WHERE retailer_id = ? AND canonical_url = ?`,
    ).get(retailerId, ref.canonicalUrl) as typeof row;
    if (evidence !== undefined) {
      database.prepare(
        `INSERT INTO product_scope_decisions
           (id, product_id, run_id, in_scope, source_category, reason,
            evidence_json, rule_version, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        row.id,
        evidence.runId,
        evidence.scope.inScope ? 1 : 0,
        ref.sourceCategory,
        evidence.scope.reason,
        JSON.stringify(evidence.scope.evidence),
        evidence.scope.ruleVersion,
        seenAt,
      );
    }
  });
  upsert.immediate();
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
     ORDER BY
       CASE WHEN last_collection_attempt_at IS NULL THEN 0 ELSE 1 END,
       last_collection_attempt_at,
       COALESCE(last_observed_at, first_seen),
       id
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

export interface CatalogSnapshotEvidence {
  runId: string;
  retailerId: string;
  complete: boolean;
  completionReason: string;
  discovered: number;
  inScope: number;
  outOfScope: number;
  completedAt: string;
}

export function activeCatalogProductCount(
  database: Database.Database,
  retailerId: string,
): number {
  return (database.prepare(
    "SELECT COUNT(*) AS count FROM products WHERE retailer_id = ? AND active = 1",
  ).get(retailerId) as { count: number }).count;
}

export function catalogDisappearanceCandidateCount(
  database: Database.Database,
  retailerId: string,
  runId: string,
): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count
    FROM products
    WHERE retailer_id = ? AND active = 1
      AND NOT EXISTS (
        SELECT 1
        FROM product_scope_decisions
        WHERE product_scope_decisions.run_id = ?
          AND product_scope_decisions.product_id = products.id
      )
  `).get(retailerId, runId) as { count: number }).count;
}

function persistCatalogSnapshot(
  database: Database.Database,
  input: CatalogSnapshotEvidence,
): number {
  if (input.discovered !== input.inScope + input.outOfScope) {
    throw new Error("Catalog snapshot scope counts do not match discovered count");
  }
  const runIdentity = database.prepare(`
    SELECT 1 FROM runs
    WHERE id = ? AND retailer_id = ? AND stage = 'discover'
      AND status = 'running' AND finished_at IS NULL
  `).get(input.runId, input.retailerId);
  if (runIdentity === undefined) {
    throw new Error("Catalog snapshot must match a running discovery run");
  }
  if (input.complete) {
    if (input.discovered === 0) {
      throw new Error("A complete catalog snapshot cannot be empty");
    }
    const active = activeCatalogProductCount(database, input.retailerId);
    const candidates = catalogDisappearanceCandidateCount(
      database,
      input.retailerId,
      input.runId,
    );
    const safeLimit = Math.max(1, Math.floor(active * 0.2));
    if (active > 0 && candidates > safeLimit) {
      throw new Error("A complete catalog snapshot cannot apply a catastrophic shrink");
    }
  }
  let disappeared = 0;
  if (input.complete) {
    const result = database.prepare(
      `UPDATE products
       SET active = 0, updated_at = ?
       WHERE retailer_id = ? AND active = 1
         AND NOT EXISTS (
           SELECT 1
           FROM product_scope_decisions
           WHERE product_scope_decisions.run_id = ?
             AND product_scope_decisions.product_id = products.id
         )`,
    ).run(input.completedAt, input.retailerId, input.runId);
    disappeared = result.changes;
  }
  database.prepare(
    `INSERT INTO catalog_snapshots
       (run_id, retailer_id, complete, completion_reason, discovered,
        in_scope, out_of_scope, disappeared, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.retailerId,
    input.complete ? 1 : 0,
    input.completionReason,
    input.discovered,
    input.inScope,
    input.outOfScope,
    disappeared,
    input.completedAt,
  );
  return disappeared;
}

export function recordCatalogSnapshot(
  database: Database.Database,
  input: CatalogSnapshotEvidence,
): number {
  return database.transaction(() => persistCatalogSnapshot(database, input)).immediate();
}

export function finalizeDiscoveryRun(
  database: Database.Database,
  input: {
    snapshot: CatalogSnapshotEvidence;
    counters: RunCounters;
    status: "completed" | "partial" | "failed";
    finishedAt: string;
    error?: { category: string; message: string };
  },
): number {
  return database.transaction(() => {
    const disappeared = persistCatalogSnapshot(database, input.snapshot);
    finalizeRun(
      database,
      input.snapshot.runId,
      input.counters,
      input.status,
      input.finishedAt,
      input.error,
    );
    return disappeared;
  }).immediate();
}

export function strategyTierNumber(strategy: Strategy): number {
  if (strategy.purpose === "discovery") {
    switch (strategy.tier) {
      case "sitemap": return 1;
      case "api": return 2;
      case "dom-crawl": return 3;
      case "script": return 4;
    }
  }
  switch (strategy.tier) {
    case "api": return 1;
    case "embedded-json": return 2;
    case "dom": return 3;
    case "script": return 4;
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
    nextStrategyVersion: (database.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM strategies WHERE retailer_id = ? AND purpose = ?`,
    ).get(retailerId, purpose) as { version: number }).version,
  };
}

export function listStrategyValidationRefs(
  database: Database.Database,
  retailerId: string,
  limit = 30,
): ProductRef[] {
  return selectStrategyValidationChallenge(database, retailerId, limit);
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
    const authoritativeRefs = listStrategyValidationRefs(
      database,
      input.retailerId,
      30,
    );
    if (authoritativeRefs.length < 30) {
      throw new Error(
        "Generated strategy activation requires at least 30 active in-scope catalog references",
      );
    }
    const testVerificationPublicKey = input.validationEvidence.testVerificationPublicKey;
    if (
      testVerificationPublicKey !== undefined
      && database.name !== ":memory:"
      && database.name !== ""
    ) {
      throw new Error("A caller-supplied validation key is forbidden for file-backed activation");
    }
    const verificationPublicKey = testVerificationPublicKey
      ?? readValidationVerificationPublicKey(
        new URL("../../ops/validation-attestation-public.pem", import.meta.url).pathname,
      );
    const evidence = validateStrategyEvidence(
      input.validationEvidence.evidence,
      {
        retailerId: input.retailerId,
        purpose: input.purpose,
        strategyVersion: versionRow.version,
        strategy: input.strategy,
        verificationPublicKey,
        authoritativeRefs,
      },
    );
    if (
      testVerificationPublicKey === undefined
      && (
        evidence.executor.artifactSha256 !== readTrustedValidatorArtifactSha256()
        || evidence.executor.challengeAlgorithm
          !== "active-in-scope-category-url-bucket-round-robin-v1"
      )
    ) {
      throw new Error("Generated strategy receipt is not bound to the trusted validator artifact");
    }
    if (canonicalEvidenceJson(evidence.samples.map(({ ref }) => ref))
      !== canonicalEvidenceJson(authoritativeRefs)) {
      throw new Error(
        "Generated strategy receipt does not match the independent validation challenge",
      );
    }
    const expectedReceiptPath = `data/validation/${input.retailerId}-${input.purpose}-v${versionRow.version}.json`;
    const receiptSha256 = validationReceiptSha256(evidence);
    if (
      evidence.activatable !== true
      || evidence.executor.mode !== "trusted-live-host"
      || evidence.attempted !== 30
      || evidence.valid < 27
      || evidence.valid !== input.validationSuccesses
      || evidence.attempted !== input.validationSampleSize
      || evidence.score !== input.validationScore
      || evidence.strategySha256 !== strategyEvidenceSha256(input.strategy)
      || input.validationEvidence.receiptPath !== expectedReceiptPath
      || input.validationEvidence.receiptSha256 !== receiptSha256
    ) {
      throw new Error("Generated strategy activation requires exact trusted receipt evidence");
    }
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
      evidence.validatedAt,
    );
    insertVerifiedStrategyValidationEvidence(database, {
      strategyId: id,
      receiptPath: expectedReceiptPath,
      receiptSha256,
      evidence,
      ...(testVerificationPublicKey === undefined
        ? {}
        : { testVerificationPublicKey }),
    });
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
    `SELECT runs.id, runs.retailer_id, runs.stage, strategies.purpose,
            runs.strategy_id, runs.collection_day, runs.status,
            runs.attempted, runs.ok, runs.failed, runs.started_at,
            runs.finished_at, runs.metadata_json
     FROM runs
     JOIN strategies ON strategies.id = runs.strategy_id
     WHERE runs.id = ?`,
  ).get(runId) as {
    id: string;
    retailer_id: string | null;
    stage: "discover" | "collect";
    purpose: StrategyPurpose;
    strategy_id: string | null;
    collection_day: string;
    status: string;
    attempted: number;
    ok: number;
    failed: number;
    started_at: string;
    finished_at: string | null;
    metadata_json: string;
  } | undefined;
  if (row === undefined || row.retailer_id === null) {
    throw new Error(`Strategy run ${runId} was not found`);
  }
  const expectedPurpose = row.stage === "discover" ? "discovery" : "extraction";
  if (row.purpose !== expectedPurpose) {
    throw new Error(`Strategy run ${runId} has mismatched stage and purpose evidence`);
  }
  let responseHints: boolean[] = [];
  let planned: number | null = null;
  let skipped = 0;
  let stoppedForBlocking = false;
  try {
    const metadata = JSON.parse(row.metadata_json) as {
      failureResponses?: unknown;
      planned?: unknown;
      skipped?: unknown;
      stoppedForBlocking?: unknown;
    };
    if (
      Array.isArray(metadata.failureResponses)
      && metadata.failureResponses.every((value) => typeof value === "boolean")
    ) {
      responseHints = metadata.failureResponses;
    }
    const plannedCandidate = Number.isSafeInteger(metadata.planned)
      && Number(metadata.planned) >= 0
      ? Number(metadata.planned)
      : null;
    const skippedCandidate = Number.isSafeInteger(metadata.skipped)
      && Number(metadata.skipped) >= 0
      ? Number(metadata.skipped)
      : null;
    if (
      plannedCandidate !== null
      && skippedCandidate !== null
      && plannedCandidate === row.attempted + skippedCandidate
    ) {
      planned = plannedCandidate;
      skipped = skippedCandidate;
      stoppedForBlocking = metadata.stoppedForBlocking === true;
    }
  } catch {
    // Immutable failure categories remain sufficient when old metadata has no hints.
  }
  const failureRows = database.prepare(
    `SELECT category, responded, canonical_url, message,
            response_path, response_sha256
     FROM run_failures WHERE run_id = ?
     ORDER BY occurred_at, id`,
  ).all(runId) as Array<{
    category: string;
    responded: number | null;
    canonical_url: string | null;
    message: string | null;
    response_path: string | null;
    response_sha256: string | null;
  }>;
  return {
    run: {
      id: row.id,
      retailerId: row.retailer_id,
      stage: row.stage,
      purpose: row.purpose,
      strategyId: row.strategy_id,
      collectionDay: row.collection_day,
      status: row.status,
      attempted: row.attempted,
      ok: row.ok,
      failed: row.failed,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      planned,
      skipped,
      stoppedForBlocking,
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
        replay: failure.response_path === null || failure.response_sha256 === null
          ? null
          : { path: failure.response_path, sha256: failure.response_sha256 },
      };
    }),
  };
}

export function listPriorSuccessfulReplayEvidence(
  database: Database.Database,
  input: {
    retailerId: string;
    beforeCollectionDay: string;
    canonicalUrls: readonly string[];
    limit?: number;
  },
): SuccessfulReplayEvidence[] {
  const limit = Math.min(input.limit ?? 5, 20);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Prior replay limit must be a positive safe integer");
  }
  const canonicalUrls = [...new Set(input.canonicalUrls.filter((url) => url.length > 0))];
  if (canonicalUrls.length === 0) return [];
  const placeholders = canonicalUrls.map(() => "?").join(", ");
  const rows = database.prepare(`
    WITH ranked AS (
      SELECT products.canonical_url AS canonicalUrl,
             observations.collection_day AS collectionDay,
             observations.response_path AS path,
             observations.response_sha256 AS sha256,
             observations.observed_at AS observedAt,
             observations.id AS observationId,
             ROW_NUMBER() OVER (
               PARTITION BY products.canonical_url
               ORDER BY observations.collection_day DESC,
                        observations.observed_at DESC,
                        observations.id DESC
             ) AS recency
      FROM observations
      JOIN products ON products.id = observations.product_id
      WHERE products.retailer_id = ?
        AND observations.collection_day < ?
        AND products.canonical_url IN (${placeholders})
        AND observations.response_path IS NOT NULL
        AND observations.response_sha256 IS NOT NULL
    )
    SELECT canonicalUrl, collectionDay, path, sha256
    FROM ranked
    WHERE recency = 1
    ORDER BY collectionDay DESC, observedAt DESC, observationId DESC
    LIMIT ?
  `).all(
    input.retailerId,
    input.beforeCollectionDay,
    ...canonicalUrls,
    limit,
  ) as Array<{
    canonicalUrl: string;
    collectionDay: string;
    path: string;
    sha256: string;
  }>;
  return rows.map((row) => ({
    canonicalUrl: row.canonicalUrl,
    collectionDay: row.collectionDay,
    replay: { path: row.path, sha256: row.sha256 },
  }));
}

export function latestTerminalCollectionRunId(
  database: Database.Database,
  retailerId: string,
): string | null {
  return latestTerminalStrategyRunId(database, retailerId, "extraction");
}

export function latestTerminalStrategyRunId(
  database: Database.Database,
  retailerId: string,
  purpose: StrategyPurpose,
): string | null {
  const stage = purpose === "discovery" ? "discover" : "collect";
  const row = database.prepare(
    `SELECT runs.id
     FROM runs
     JOIN strategies ON strategies.id = runs.strategy_id
     WHERE runs.retailer_id = ? AND runs.stage = ?
       AND strategies.purpose = ?
       AND runs.finished_at IS NOT NULL
       AND runs.status IN ('completed', 'partial', 'failed')
     ORDER BY runs.collection_day DESC, runs.finished_at DESC, runs.id DESC
     LIMIT 1`,
  ).get(retailerId, stage, purpose) as { id: string } | undefined;
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
        input.healingEventId,
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

function hasUnresolvedHealingDegradation(
  database: Database.Database,
  retailerId: string,
  purpose: StrategyPurpose,
): boolean {
  const events = database.prepare(`
    SELECT status
    FROM healing_events
    WHERE retailer_id = ? AND purpose = ?
    ORDER BY rowid
  `).all(retailerId, purpose) as Array<{ status: string }>;
  let consecutiveFailures = 0;
  let unresolved = false;
  for (const event of events) {
    if (event.status === "recovered") {
      consecutiveFailures = 0;
      unresolved = false;
    } else if (event.status === "failed") {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) unresolved = true;
    } else if (!unresolved) {
      consecutiveFailures = 0;
    }
  }
  return unresolved;
}

export function setRetailerDegraded(
  database: Database.Database,
  retailerId: string,
  degraded: boolean,
  reason?: string,
  updatedAt = new Date().toISOString(),
  healingEventId?: string,
): boolean {
  const transition = database.transaction(() => {
    const current = database.prepare(
      "SELECT degraded FROM retailers WHERE id = ?",
    ).get(retailerId) as { degraded: number } | undefined;
    if (current === undefined) throw new Error(`Retailer ${retailerId} was not found`);
    const healingEvent = healingEventId === undefined
      ? null
      : findHealingEvent(database, "id = ?", healingEventId);
    if (healingEventId !== undefined && healingEvent === null) {
      throw new Error(`Healing event ${healingEventId} was not found`);
    }
    if (healingEvent !== null && healingEvent.retailerId !== retailerId) {
      throw new Error("Retailer state transition healing identity does not match the retailer");
    }
    if (
      healingEvent !== null
      && healingEvent.status !== (degraded ? "failed" : "recovered")
    ) {
      throw new Error("Retailer state transition does not match the healing event status");
    }
    const healingPurpose = healingEvent?.purpose ?? null;
    if (!degraded && current.degraded === 1 && healingEventId !== undefined) {
      const unresolvedPurpose = (["discovery", "extraction"] as const).find((purpose) =>
        hasUnresolvedHealingDegradation(database, retailerId, purpose));
      if (unresolvedPurpose !== undefined) {
        return true;
      }
    }
    const nextReason = degraded ? reason ?? "strategy regeneration failed" : null;
    if ((current.degraded === 1) !== degraded) {
      database.prepare(`
        INSERT INTO retailer_state_events
          (retailer_id, healing_event_id, purpose, state, reason, source, effective_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        retailerId,
        healingEventId ?? null,
        healingPurpose ?? null,
        degraded ? "degraded" : "recovered",
        nextReason,
        healingEventId === undefined ? "retailer_transition" : "healing_transition",
        updatedAt,
      );
    }
    const result = database.prepare(
      `UPDATE retailers
       SET degraded = ?, degraded_reason = ?, updated_at = ?
       WHERE id = ?`,
    ).run(degraded ? 1 : 0, nextReason, updatedAt, retailerId);
    if (result.changes !== 1) throw new Error(`Retailer ${retailerId} was not found`);
    return degraded;
  });
  return transition.immediate();
}

const REPLAY_REFERENCE_PATH = new RegExp(
  String.raw`^(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-f0-9]{64})\.(?:html|json|txt)\.gz$`,
  "u",
);

function validateReplayReference(
  reference: ReplayReference | undefined,
  expected?: { collectionDay: string; retailerId: string },
): void {
  if (reference === undefined) return;
  const match = REPLAY_REFERENCE_PATH.exec(reference.path);
  if (match === null || match[3] !== reference.sha256) {
    throw new Error("Replay reference must be a relative content-addressed private path");
  }
  if (
    expected !== undefined
    && (match[1] !== expected.collectionDay || match[2] !== expected.retailerId)
  ) {
    throw new Error("Replay reference day and retailer must match its evidence row");
  }
}

function replayContextForRun(
  database: Database.Database,
  runId: string,
): {
  collectionDay: string;
  retailerId: string;
  stage: "discover" | "collect";
  strategyId: string | null;
  strategyVersion: number | null;
  status: string;
  finishedAt: string | null;
} {
  const row = database.prepare(`
    SELECT collection_day AS collectionDay, retailer_id AS retailerId,
           stage, strategy_id AS strategyId, strategy_version AS strategyVersion,
           status, finished_at AS finishedAt
    FROM runs WHERE id = ?
  `).get(runId) as {
    collectionDay: string;
    retailerId: string;
    stage: "discover" | "collect";
    strategyId: string | null;
    strategyVersion: number | null;
    status: string;
    finishedAt: string | null;
  } | undefined;
  if (row === undefined) throw new Error(`Run ${runId} was not found`);
  return row;
}

export function countReplayEvidenceForDay(
  database: Database.Database,
  retailerId: string,
  day: string,
): number {
  const row = database.prepare(
    `SELECT COUNT(*) AS count
     FROM (
       SELECT observations.id
       FROM observations
       JOIN products ON products.id = observations.product_id
       WHERE products.retailer_id = ?
         AND observations.collection_day = ?
         AND observations.response_path IS NOT NULL
       UNION ALL
       SELECT run_failures.id
       FROM run_failures
       JOIN runs ON runs.id = run_failures.run_id
       WHERE run_failures.retailer_id = ?
         AND runs.collection_day = ?
         AND run_failures.response_path IS NOT NULL
     )`,
  ).get(retailerId, day, retailerId, day) as { count: number };
  return row.count;
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
    id?: string;
  },
): string {
  const context = replayContextForRun(database, input.runId);
  if (
    context.retailerId !== input.retailerId
    || context.status !== "running"
    || context.finishedAt !== null
    || context.strategyId !== input.strategyId
    || context.strategyVersion !== input.strategyVersion
  ) {
    throw new Error("Failure evidence must match its running run and strategy");
  }
  if (input.product !== undefined) {
    const product = database.prepare(
      "SELECT retailer_id AS retailerId FROM products WHERE id = ?",
    ).get(input.product.id) as { retailerId: string } | undefined;
    if (
      product?.retailerId !== context.retailerId
      || context.stage !== "collect"
    ) {
      throw new Error("Failure product must match its running collection run");
    }
  }
  validateReplayReference(input.replay, context);
  const id = input.id ?? randomUUID();
  const insert = database.transaction(() => {
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
    if (input.product !== undefined) {
      database.prepare(
        `UPDATE products
         SET last_collection_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.occurredAt, input.occurredAt, input.product.id);
    }
  });
  insert.immediate();
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
    id?: string;
  },
): string {
  if (input.result.ok !== true || input.result.fields === undefined) {
    throw new Error("A successful extraction result is required");
  }
  const fields = input.result.fields;
  if (!isDescriptiveProductTitle(fields.title)) {
    throw new Error("Observed product title is not descriptive text");
  }
  const run = replayContextForRun(database, input.runId);
  const product = database.prepare(
    "SELECT retailer_id AS retailerId FROM products WHERE id = ?",
  ).get(input.product.id) as { retailerId: string } | undefined;
  if (product === undefined) throw new Error(`Product ${input.product.id} was not found`);
  if (
    run.stage !== "collect"
    || run.status !== "running"
    || run.finishedAt !== null
    || run.collectionDay !== input.collectionDay
    || run.retailerId !== product.retailerId
    || run.strategyId !== input.strategyId
    || run.strategyVersion !== input.strategyVersion
  ) {
    throw new Error("Observation must match its running collection run and strategy");
  }
  validateReplayReference(input.replay, run);
  const id = input.id ?? randomUUID();
  const unit = normalizeUnit(fields.unit);
  const transaction = database.transaction(() => {
    database.prepare(
      `UPDATE products
       SET title = ?, brand = ?, raw_unit = ?, quantity_value = ?,
           quantity_unit = ?, base_quantity = ?, base_unit = ?,
           descriptive_title = 1, last_observed_at = ?,
           last_collection_attempt_at = ?, updated_at = ?
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
  reportDay: string;
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
    yesterdayRun: null | {
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
  latest_collection_day: string | null;
  latest_attempted: number | null;
  latest_ok: number | null;
  latest_failed: number | null;
  yesterday_collection_day: string | null;
  yesterday_attempted: number | null;
  yesterday_ok: number | null;
  yesterday_failed: number | null;
}

interface HeartbeatRow {
  completed_at: string | null;
}

const HEARTBEAT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

function saoPauloCalendarDay(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function previousCalendarDay(day: string): string {
  const value = new Date(`${day}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function readStatusReport(
  database: Database.Database,
  now: Date = new Date(),
): StatusReport {
  const reportDay = previousCalendarDay(saoPauloCalendarDay(now));
  const rows = database
    .prepare(
      `SELECT
         retailer.id,
         retailer.name,
         retailer.active,
         retailer.degraded,
         latest.collection_day AS latest_collection_day,
         latest.attempted AS latest_attempted,
         latest.ok AS latest_ok,
         latest.failed AS latest_failed,
         yesterday.collection_day AS yesterday_collection_day,
         yesterday.attempted AS yesterday_attempted,
         yesterday.ok AS yesterday_ok,
         yesterday.failed AS yesterday_failed
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
       LEFT JOIN runs AS yesterday
         ON yesterday.id = (
           SELECT candidate.id
           FROM runs AS candidate
           WHERE candidate.retailer_id = retailer.id
             AND candidate.stage = 'collect'
             AND candidate.collection_day = @reportDay
           ORDER BY
             COALESCE(candidate.finished_at, candidate.started_at) DESC,
             candidate.id DESC
           LIMIT 1
         )
       ORDER BY retailer.name COLLATE NOCASE, retailer.id`,
    )
    .all({ reportDay }) as StatusRow[];

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
    reportDay,
    staleHeartbeat:
      !Number.isFinite(completedAt) || now.getTime() - completedAt > HEARTBEAT_STALE_AFTER_MS,
    retailers: rows.map((row) => {
      const latestAttempted = row.latest_attempted ?? 0;
      const latestRun = row.latest_collection_day === null
        ? null
        : {
            collectionDay: row.latest_collection_day,
            attempted: latestAttempted,
            ok: row.latest_ok ?? 0,
            failed: row.latest_failed ?? 0,
            successRate: latestAttempted === 0
              ? 0
              : (row.latest_ok ?? 0) / latestAttempted,
          };
      const yesterdayAttempted = row.yesterday_attempted ?? 0;
      const yesterdayRun = row.yesterday_collection_day === null
        ? null
        : {
            collectionDay: row.yesterday_collection_day,
            attempted: yesterdayAttempted,
            ok: row.yesterday_ok ?? 0,
            failed: row.yesterday_failed ?? 0,
            successRate: yesterdayAttempted === 0
              ? 0
              : (row.yesterday_ok ?? 0) / yesterdayAttempted,
          };

      return {
        id: row.id,
        name: row.name,
        active: row.active === 1,
        degraded: row.degraded === 1,
        latestRun,
        yesterdayRun,
      };
    }),
  };
}
