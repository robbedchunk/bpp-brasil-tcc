import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";

import type { AlertSink } from "../ops/alerts.js";
import {
  BudgetGuard,
  RELEASED_CLASSIFICATION_BATCH_STATUSES,
  reserveSynchronousClassificationBudget,
  settleSynchronousClassificationBudget,
} from "../ops/budget.js";
import { DEFAULT_CLASSIFICATION_MODEL } from "./openai-provider.js";
import { ClassificationProviderError } from "./provider.js";
import {
  reconcileClassificationMeasurementScope,
  type ClassificationScopeReconciliation,
} from "./measurement-scope.js";
import type {
  AllowedIpcaItem,
  ClassificationAttemptEvidence,
  ClassificationBatchResult,
  ClassificationInput,
  ClassificationResult,
  ProductClassifier,
} from "./provider.js";

export interface ClassifyNewProductsOptions {
  batchSize?: number;
  concurrency?: number;
  minimumBatchSize?: number;
  version: number;
  confidenceThreshold: number;
  dryRun?: boolean;
}

export interface ClassificationDependencies {
  database: Database.Database;
  provider?: ProductClassifier;
  budgetGuard?: BudgetGuard;
  classificationModel?: string;
  now?: () => Date;
  alertSink?: AlertSink;
}

export type ClassificationRunStatus =
  | "completed"
  | "dry_run"
  | "provider_unavailable"
  | "budget_denied"
  | "no_ipca_items"
  | "shape_failure_paused";

export interface ClassificationRunSummary {
  status: ClassificationRunStatus;
  dryRun: boolean;
  version: number;
  confidenceThreshold: number;
  batchSize: number;
  plannedBatches: number;
  batches: number;
  eligible: number;
  classified: number;
  unclassified: number;
  pending: number;
  budgetDenied: number;
  estimatedCostUsd: number;
  shapeFailedBatches: number;
  shapeFailedProducts: number;
  shapeFailurePaused: boolean;
  quarantinedActive: number;
  quarantinedNew: number;
  quarantinedProductIds: string[];
  failureSpendRunUsd: number;
  failureSpendMonthUsd: number;
  scopeReconciliation: ClassificationScopeReconciliation;
}

/** Provider failure kinds where the response itself violated the
 * exactly-one-result-per-input contract (or never contained a usable result).
 * Retrying the identical request nightly is what wedged 2026-07-14/15, so
 * these mark the batch for an adaptive split instead of a blind resubmit. */
export const SHAPE_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "validation_failed",
  "schema_invalid",
  "incomplete",
  "refusal",
]);

/** Shape failures per (product, version) before the product is quarantined
 * instead of retried. Counted since the product's latest operator release. */
export const SHAPE_FAILURE_QUARANTINE_THRESHOLD = 3;

/** The adaptive split halves the batch per prior failure but never shrinks a
 * request below this floor, so one bad batch cannot fan out into dozens of
 * tiny paid calls. */
export const MIN_ADAPTIVE_BATCH_SIZE = 10;

/** Shape failures tolerated within a single run before it pauses fail-closed.
 * Bounds one night's failure spend when the provider is systemically broken. */
export const MAX_RUN_SHAPE_FAILURES = 3;

export interface ClassificationProduct {
  id: string;
  retailer_id: string;
  title: string;
  brand: string | null;
  source_category: string | null;
}

interface IpcaItemRow {
  id: string;
  code: string;
  name: string;
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function confidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("confidenceThreshold must be between 0 and 1");
  }
  return value;
}

function listItems(database: Database.Database): AllowedIpcaItem[] {
  return (database.prepare(
    `SELECT id, code, name
     FROM ipca_items
     WHERE in_scope = 1 AND item_group = 'alimentacao_no_domicilio'
     ORDER BY code, id`,
  ).all() as IpcaItemRow[]).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
  }));
}

function listEligibleProducts(database: Database.Database, version: number): ClassificationProduct[] {
  const releasedPlaceholders = RELEASED_CLASSIFICATION_BATCH_STATUSES.map(() => "?").join(", ");
  return database.prepare(
    `SELECT p.id, p.retailer_id, p.title, p.brand, p.source_category
     FROM products p
     WHERE p.active = 1
       AND p.in_scope = 1
       AND p.descriptive_title = 1
       AND NOT EXISTS (
         SELECT 1 FROM classifications c
         WHERE c.product_id = p.id AND c.version = ?
       )
       AND NOT EXISTS (
         SELECT 1
         FROM classification_batch_items bi
         JOIN classification_batch_jobs bj ON bj.id = bi.job_id
         WHERE bi.product_id = p.id
           AND bj.version = ?
           AND bj.status NOT LIKE 'finalized%'
           AND bj.status NOT IN (${releasedPlaceholders})
       )
     ORDER BY p.id`,
  ).all(
    version,
    version,
    ...RELEASED_CLASSIFICATION_BATCH_STATUSES,
  ) as ClassificationProduct[];
}

function inputFor(
  product: ClassificationProduct,
  allowedItems: readonly AllowedIpcaItem[],
): ClassificationInput {
  return {
    productId: product.id,
    title: product.title,
    brand: product.brand,
    sourceCategory: product.source_category,
    allowedItems,
  };
}

export function validateBatchResult(
  batch: readonly ClassificationInput[],
  result: ClassificationBatchResult,
): Map<string, ClassificationResult> {
  if (
    result.provider.trim().length === 0
    || result.model.trim().length === 0
    || result.promptVersion.trim().length === 0
    || !/^[a-f0-9]{64}$/u.test(result.promptHash)
  ) {
    throw new Error("Classification provider metadata is incomplete");
  }
  if (
    !Number.isSafeInteger(result.usage.inputTokens)
    || result.usage.inputTokens < 0
    || !Number.isSafeInteger(result.usage.outputTokens)
    || result.usage.outputTokens < 0
  ) {
    throw new Error("Classification provider usage must contain non-negative token integers");
  }
  if (result.results.length !== batch.length) {
    throw new Error("Classification provider must return exactly one result per input");
  }
  const inputById = new Map(batch.map((input) => [input.productId, input]));
  const results = new Map<string, ClassificationResult>();
  for (const item of result.results) {
    const input = inputById.get(item.productId);
    if (input === undefined || results.has(item.productId)) {
      throw new Error(`Unexpected or duplicate classification result: ${item.productId}`);
    }
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`Invalid classification confidence for ${item.productId}`);
    }
    if (item.rationaleCode.trim().length === 0) {
      throw new Error(`Missing rationale code for ${item.productId}`);
    }
    if (
      item.ipcaItemId !== null
      && !input.allowedItems.some((allowed) => allowed.id === item.ipcaItemId)
    ) {
      throw new Error(`Classification result is outside the allowlist: ${item.ipcaItemId}`);
    }
    results.set(item.productId, item);
  }
  return results;
}

function integerShare(total: number, count: number, index: number): number {
  const base = Math.floor(total / count);
  return base + (index < total % count ? 1 : 0);
}

function decimalShares(total: number, count: number): number[] {
  const decimal = new Decimal(total);
  const base = decimal.div(count).toDecimalPlaces(12, Decimal.ROUND_DOWN);
  return Array.from({ length: count }, (_, index) =>
    (index === count - 1 ? decimal.minus(base.mul(count - 1)) : base).toNumber());
}

export function persistClassificationBatch(
  database: Database.Database,
  batch: readonly ClassificationInput[],
  products: ReadonlyMap<string, ClassificationProduct>,
  providerResult: ClassificationBatchResult,
  threshold: number,
  version: number,
  occurredAt: string,
  estimatedCostUsd: number,
  classificationReservationId?: string,
): number {
  const resultByProduct = validateBatchResult(batch, providerResult);
  const costShares = decimalShares(estimatedCostUsd, batch.length);
  const insertClassification = database.prepare(`
    INSERT INTO classifications
      (id, product_id, ipca_item_id, version, decision, confidence, method,
       prompt_version, model, input_json, output_json, input_tokens,
       output_tokens, cost_usd, created_at)
    VALUES
      (@id, @productId, @ipcaItemId, @version, @decision, @confidence, 'llm',
       @promptVersion, @model, @inputJson, @outputJson, @inputTokens,
       @outputTokens, @costUsd, @createdAt)
  `);
  const updatePointer = database.prepare(`
    UPDATE products
    SET current_ipca_item_id = ?, updated_at = ?
    WHERE id = ?
      AND NOT EXISTS (
        SELECT 1 FROM classifications newer
        WHERE newer.product_id = products.id AND newer.version > ?
      )
  `);
  const insertCost = database.prepare(`
    INSERT INTO cost_ledger
      (id, category, retailer_id, classification_id,
       classification_reservation_id, provider, model,
       input_tokens, output_tokens, cost_usd, occurred_at, details_json)
    VALUES
      (?, 'classification', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let unclassified = 0;
  batch.forEach((input, index) => {
    const raw = resultByProduct.get(input.productId);
    const product = products.get(input.productId);
    if (raw === undefined || product === undefined) {
      throw new Error(`Missing validated product classification: ${input.productId}`);
    }
    const assignedId = raw.confidence >= threshold ? raw.ipcaItemId : null;
    const assignedCode = assignedId === null
      ? null
      : input.allowedItems.find((item) => item.id === assignedId)?.code ?? null;
    if (assignedId !== null && assignedCode === null) {
      throw new Error(`Missing allowed SNIPC code for ${assignedId}`);
    }
    if (assignedId === null) unclassified += 1;
    const classificationId = randomUUID();
    const inputTokens = integerShare(providerResult.usage.inputTokens, batch.length, index);
    const outputTokens = integerShare(providerResult.usage.outputTokens, batch.length, index);
    const costUsd = costShares[index] ?? 0;
    insertClassification.run({
      id: classificationId,
      productId: input.productId,
      ipcaItemId: assignedId,
      version,
      decision: assignedCode ?? "unclassified",
      confidence: raw.confidence,
      promptVersion: providerResult.promptVersion,
      model: providerResult.model,
      inputJson: JSON.stringify({
        productId: input.productId,
        title: input.title,
        brand: input.brand,
        sourceCategory: input.sourceCategory,
        allowedItems: input.allowedItems,
        promptHash: providerResult.promptHash,
      }),
      outputJson: JSON.stringify(raw),
      inputTokens,
      outputTokens,
      costUsd,
      createdAt: occurredAt,
    });
    updatePointer.run(assignedId, occurredAt, input.productId, version);
    insertCost.run(
      randomUUID(),
      product.retailer_id,
      classificationId,
      classificationReservationId ?? null,
      providerResult.provider,
      providerResult.model,
      inputTokens,
      outputTokens,
      costUsd,
      occurredAt,
      JSON.stringify({
        estimated: true,
        allocation: "batch_proportional",
        promptHash: providerResult.promptHash,
        promptVersion: providerResult.promptVersion,
      }),
    );
  });
  return unclassified;
}

export function persistFailureAttempts(
  database: Database.Database,
  attempts: readonly ClassificationAttemptEvidence[],
  budgetGuard: BudgetGuard,
  context: {
    occurredAt: string;
    productIds: readonly string[];
    version: number;
    batchJobId?: string;
    classificationReservationId?: string;
  },
): number {
  const insert = database.prepare(`
    INSERT INTO cost_ledger
      (id, category, classification_reservation_id, provider, model,
       input_tokens, output_tokens,
       cost_usd, occurred_at, details_json)
    VALUES
      (?, 'classification_failure', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let total = new Decimal(0);
  for (const attempt of attempts) {
    const cost = budgetGuard.estimateModelCost({
      model: attempt.actualModel,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
    });
    insert.run(
      randomUUID(),
      context.classificationReservationId ?? null,
      attempt.provider,
      attempt.actualModel,
      attempt.inputTokens,
      attempt.outputTokens,
      cost,
      context.occurredAt,
      JSON.stringify({
        estimated: true,
        requestedModel: attempt.requestedModel,
        responseId: attempt.responseId,
        attempt: attempt.attempt,
        failureKind: attempt.failureKind,
        productIds: context.productIds,
        version: context.version,
        ...(context.batchJobId === undefined ? {} : { batchJobId: context.batchJobId }),
      }),
    );
    total = total.plus(cost);
  }
  return total.toDecimalPlaces(12).toNumber();
}

/** Mirrors the reservation fingerprint in ops/budget.ts so shape-failure
 * evidence can be joined against classification_sync_reservations. */
function classificationRequestSha256(input: {
  version: number;
  model: string;
  productIds: readonly string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: input.version,
    model: input.model,
    productIds: input.productIds,
  })).digest("hex");
}

/** Shape failures per product since the product's latest operator release.
 * A release resets the count so released products restart at the full batch
 * size instead of being re-quarantined by stale history. */
export function shapeFailureCounts(
  database: Database.Database,
  version: number,
): Map<string, number> {
  const rows = database.prepare(`
    SELECT f.product_id AS productId, COUNT(*) AS failures
    FROM classification_shape_failures f
    WHERE f.version = ?
      AND f.occurred_at > COALESCE((
        SELECT MAX(r.occurred_at)
        FROM classification_quarantine_events r
        WHERE r.version = f.version
          AND r.product_id = f.product_id
          AND r.action = 'released'
      ), '')
    GROUP BY f.product_id
  `).all(version) as Array<{ productId: string; failures: number }>;
  return new Map(rows.map((row) => [row.productId, row.failures]));
}

export function recordClassificationShapeFailure(
  database: Database.Database,
  input: {
    version: number;
    model: string;
    productIds: readonly string[];
    failureKind: string;
    occurredAt: string;
    details?: Record<string, unknown>;
  },
): void {
  const requestSha256 = classificationRequestSha256({
    version: input.version,
    model: input.model,
    productIds: input.productIds,
  });
  const detailsJson = JSON.stringify(input.details ?? {});
  const insert = database.prepare(`
    INSERT INTO classification_shape_failures
      (id, product_id, version, request_sha256, model, batch_size,
       failure_kind, occurred_at, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const productId of input.productIds) {
    insert.run(
      randomUUID(),
      productId,
      input.version,
      requestSha256,
      input.model,
      input.productIds.length,
      input.failureKind,
      input.occurredAt,
      detailsJson,
    );
  }
}

export function listActiveClassificationQuarantine(
  database: Database.Database,
  version: number,
): string[] {
  return (database.prepare(`
    SELECT e.product_id AS productId
    FROM classification_quarantine_events e
    WHERE e.version = ?
    GROUP BY e.product_id
    HAVING (
      SELECT latest.action FROM classification_quarantine_events latest
      WHERE latest.version = e.version AND latest.product_id = e.product_id
      ORDER BY latest.occurred_at DESC, latest.rowid DESC
      LIMIT 1
    ) = 'quarantined'
    ORDER BY e.product_id
  `).all(version) as Array<{ productId: string }>).map(({ productId }) => productId);
}

/** Appends quarantine events for the given products, skipping any that are
 * already quarantined. Returns the newly quarantined product IDs. */
export function quarantineClassificationProducts(
  database: Database.Database,
  input: {
    version: number;
    productIds: readonly string[];
    reason: string;
    occurredAt: string;
    details?: Record<string, unknown>;
  },
): string[] {
  return database.transaction((): string[] => {
    const active = new Set(listActiveClassificationQuarantine(database, input.version));
    const fresh = [...new Set(input.productIds)]
      .filter((productId) => !active.has(productId))
      .sort((left, right) => left.localeCompare(right, "en"));
    const insert = database.prepare(`
      INSERT INTO classification_quarantine_events
        (id, product_id, version, action, reason, occurred_at, details_json)
      VALUES (?, ?, ?, 'quarantined', ?, ?, ?)
    `);
    const detailsJson = JSON.stringify(input.details ?? {});
    for (const productId of fresh) {
      insert.run(
        randomUUID(),
        productId,
        input.version,
        input.reason,
        input.occurredAt,
        detailsJson,
      );
    }
    return fresh;
  }).immediate();
}

/** Operator action: lifts the quarantine on the given products (or on every
 * quarantined product of the version when productIds is omitted). Products
 * become eligible again on the next run with a reset shape-failure count. */
export function releaseClassificationQuarantine(
  database: Database.Database,
  input: {
    version: number;
    productIds?: readonly string[];
    reason: string;
    occurredAt: string;
    details?: Record<string, unknown>;
  },
): string[] {
  return database.transaction((): string[] => {
    const active = listActiveClassificationQuarantine(database, input.version);
    const requested = input.productIds === undefined
      ? null
      : new Set(input.productIds);
    const releasable = active.filter(
      (productId) => requested === null || requested.has(productId),
    );
    const insert = database.prepare(`
      INSERT INTO classification_quarantine_events
        (id, product_id, version, action, reason, occurred_at, details_json)
      VALUES (?, ?, ?, 'released', ?, ?, ?)
    `);
    const detailsJson = JSON.stringify(input.details ?? {});
    for (const productId of releasable) {
      insert.run(
        randomUUID(),
        productId,
        input.version,
        input.reason,
        input.occurredAt,
        detailsJson,
      );
    }
    return releasable;
  }).immediate();
}

/** Chunks eligible products into batches, halving the batch size for each
 * prior shape failure so a repeatedly failing product set is isolated
 * instead of resubmitted as the identical oversized request. */
export function planClassificationBatches(
  products: readonly ClassificationProduct[],
  failureCounts: ReadonlyMap<string, number>,
  baseBatchSize: number,
  minimumBatchSize: number = MIN_ADAPTIVE_BATCH_SIZE,
): ClassificationProduct[][] {
  const tiers = new Map<number, ClassificationProduct[]>();
  for (const product of products) {
    const failures = failureCounts.get(product.id) ?? 0;
    const tier = tiers.get(failures) ?? [];
    tier.push(product);
    tiers.set(failures, tier);
  }
  const batches: ClassificationProduct[][] = [];
  for (const failures of [...tiers.keys()].sort((left, right) => left - right)) {
    const tier = tiers.get(failures) ?? [];
    const target = Math.min(
      baseBatchSize,
      Math.max(minimumBatchSize, Math.floor(baseBatchSize / 2 ** failures)),
    );
    for (let offset = 0; offset < tier.length; offset += target) {
      batches.push(tier.slice(offset, offset + target));
    }
  }
  return batches;
}

/** Ledger honesty: everything the month has already burned on failed
 * classification attempts, surfaced in the run summary so the operator sees
 * the bleed instead of discovering it at the budget cap. */
export function classificationFailureSpendMonthUsd(
  database: Database.Database,
  now: Date,
): number {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return (database.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS spend
    FROM cost_ledger
    WHERE category = 'classification_failure'
      AND occurred_at >= ? AND occurred_at < ?
  `).get(monthStart, nextMonth) as { spend: number }).spend;
}

function uniqueClassificationConflict(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && error.code.startsWith("SQLITE_CONSTRAINT_UNIQUE");
}

function plannedUsage(inputs: readonly ClassificationInput[]): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: Math.max(1, Math.ceil(JSON.stringify(inputs).length / 3)),
    outputTokens: Math.max(1, inputs.length * 80),
  };
}

export async function classifyNewProducts(
  options: ClassifyNewProductsOptions,
  dependencies: ClassificationDependencies,
): Promise<ClassificationRunSummary> {
  const batchSize = positiveInteger("batchSize", options.batchSize ?? 50, 500);
  const concurrency = positiveInteger(
    "concurrency",
    options.concurrency ?? 1,
    MAX_RUN_SHAPE_FAILURES,
  );
  const minimumBatchSize = positiveInteger(
    "minimumBatchSize",
    options.minimumBatchSize ?? Math.min(MIN_ADAPTIVE_BATCH_SIZE, batchSize),
    batchSize,
  );
  const version = positiveInteger("version", options.version, 1_000_000);
  const threshold = confidence(options.confidenceThreshold);
  const dryRun = options.dryRun === true;
  const now = dependencies.now ?? (() => new Date());
  const scopeReconciliation = dryRun
    ? {
        version,
        considered: 0,
        excluded: 0,
        retainedForReview: 0,
        policyVersion: "ipca-84-classification-scope-v1" as const,
      }
    : reconcileClassificationMeasurementScope(dependencies.database, {
        version,
        confidenceThreshold: threshold,
        decidedAt: now().toISOString(),
      });
  const products = listEligibleProducts(dependencies.database, version);
  const allowedItems = listItems(dependencies.database);
  const plannedBatches = Math.ceil(products.length / batchSize);
  const base = {
    dryRun,
    version,
    confidenceThreshold: threshold,
    batchSize,
    plannedBatches,
    batches: 0,
    eligible: products.length,
    classified: 0,
    unclassified: 0,
    pending: products.length,
    budgetDenied: 0,
    estimatedCostUsd: 0,
    shapeFailedBatches: 0,
    shapeFailedProducts: 0,
    shapeFailurePaused: false,
    quarantinedActive: 0,
    quarantinedNew: 0,
    quarantinedProductIds: [] as string[],
    failureSpendRunUsd: 0,
    failureSpendMonthUsd: classificationFailureSpendMonthUsd(dependencies.database, now()),
    scopeReconciliation,
  };
  if (dryRun) return { ...base, status: "dry_run" };
  if (products.length === 0) return { ...base, status: "completed" };
  if (allowedItems.length === 0) return { ...base, status: "no_ipca_items" };
  if (dependencies.provider === undefined) {
    return { ...base, status: "provider_unavailable" };
  }

  const budgetGuard = dependencies.budgetGuard ?? BudgetGuard.fromEnv();
  const model = dependencies.classificationModel ?? DEFAULT_CLASSIFICATION_MODEL;
  const productById = new Map(products.map((product) => [product.id, product]));

  // Circuit breaker: products that keep failing the shape invariant are
  // quarantined (visibly, reversibly) instead of being resubmitted nightly.
  const failureCounts = shapeFailureCounts(dependencies.database, version);
  const previouslyQuarantined = new Set(
    listActiveClassificationQuarantine(dependencies.database, version),
  );
  const quarantineCandidates = products
    .filter((product) => !previouslyQuarantined.has(product.id)
      && (failureCounts.get(product.id) ?? 0) >= SHAPE_FAILURE_QUARANTINE_THRESHOLD)
    .map((product) => product.id);
  const newlyQuarantined = quarantineCandidates.length === 0
    ? []
    : quarantineClassificationProducts(dependencies.database, {
        version,
        productIds: quarantineCandidates,
        reason: "shape_failure_circuit_breaker",
        occurredAt: now().toISOString(),
        details: { threshold: SHAPE_FAILURE_QUARANTINE_THRESHOLD, model },
      });
  if (newlyQuarantined.length > 0) {
    await dependencies.alertSink?.send({
      severity: "error",
      title: "IPCA classification products quarantined",
      message: `${newlyQuarantined.length} product(s) failed the classification `
        + `output-shape invariant ${SHAPE_FAILURE_QUARANTINE_THRESHOLD} times and were `
        + "quarantined; release with releaseClassificationQuarantine after review",
      details: {
        version,
        quarantined: newlyQuarantined.length,
        productIds: newlyQuarantined.slice(0, 50),
        threshold: SHAPE_FAILURE_QUARANTINE_THRESHOLD,
      },
    });
  }
  const quarantined = new Set([...previouslyQuarantined, ...newlyQuarantined]);
  const quarantinedEligible = products
    .filter((product) => quarantined.has(product.id))
    .map((product) => product.id);
  const batchable = products.filter((product) => !quarantined.has(product.id));
  const plan = planClassificationBatches(
    batchable,
    failureCounts,
    batchSize,
    minimumBatchSize,
  );

  let batches = 0;
  let classified = 0;
  let unclassified = 0;
  let budgetDenied = 0;
  let shapeFailedBatches = 0;
  let shapeFailedProducts = 0;
  let shapeFailurePaused = false;
  let estimatedCostUsd = new Decimal(0);
  let failureSpendRunUsd = new Decimal(0);

  interface ScheduledBatch {
    inputBatch: ClassificationInput[];
    reservationId: string;
    providerResult: Promise<ClassificationBatchResult>;
  }
  const scheduled: ScheduledBatch[] = [];
  let nextBatchIndex = 0;

  const scheduleNext = (): boolean => {
    const productBatch = plan[nextBatchIndex];
    if (productBatch === undefined) return false;
    const inputBatch = productBatch.map((product) => inputFor(product, allowedItems));
    const projectedCost = budgetGuard.estimateModelCost({
      model,
      ...plannedUsage(inputBatch),
    });
    const reservation = reserveSynchronousClassificationBudget(
      dependencies.database,
      {
        version,
        model,
        productIds: inputBatch.map(({ productId }) => productId),
        projectedCostUsd: projectedCost,
        now: now(),
        budgetGuard,
      },
    );
    if (!reservation.reserved || reservation.reservationId === null) {
      budgetDenied = plan.slice(nextBatchIndex)
        .reduce((count, batch) => count + batch.length, 0);
      nextBatchIndex = plan.length;
      return false;
    }
    const providerResult = dependencies.provider!.classify(inputBatch);
    // Attach a rejection handler immediately because a later scheduled request
    // may finish before it becomes the next batch awaited by the settlement loop.
    void providerResult.catch(() => undefined);
    scheduled.push({
      inputBatch,
      reservationId: reservation.reservationId,
      providerResult,
    });
    nextBatchIndex += 1;
    return true;
  };

  const replenish = (): void => {
    const failureCapacity = MAX_RUN_SHAPE_FAILURES - shapeFailedBatches;
    const target = Math.min(concurrency, failureCapacity);
    while (scheduled.length < target && scheduleNext()) {
      // scheduleNext mutates the queue until the bounded target is full.
    }
  };

  replenish();
  while (scheduled.length > 0) {
    const scheduledBatch = scheduled.shift();
    if (scheduledBatch === undefined) break;
    const { inputBatch, reservationId } = scheduledBatch;

    let providerResult: ClassificationBatchResult;
    try {
      providerResult = await scheduledBatch.providerResult;
    } catch (error) {
      if (!(error instanceof ClassificationProviderError) || error.attempts.length === 0) {
        throw error;
      }
      const providerError = error;
      const terminalKind = providerError.attempts.at(-1)?.failureKind ?? "";
      const shapeFailure = SHAPE_FAILURE_KINDS.has(terminalKind);
      const occurredAt = now().toISOString();
      let settledFailureCost = 0;
      const transaction = dependencies.database.transaction(() => {
        settledFailureCost = persistFailureAttempts(
          dependencies.database,
          providerError.attempts,
          budgetGuard,
          {
            occurredAt,
            productIds: inputBatch.map((input) => input.productId),
            version,
            classificationReservationId: reservationId,
          },
        );
        settleSynchronousClassificationBudget(dependencies.database, {
          reservationId,
          actualCostUsd: settledFailureCost,
          settledAt: occurredAt,
          status: "settled",
          details: {
            providerFailed: true,
            attemptEvidence: providerError.attempts.length,
            ...(shapeFailure ? { shapeFailureKind: terminalKind } : {}),
          },
        });
        if (shapeFailure) {
          recordClassificationShapeFailure(dependencies.database, {
            version,
            model,
            productIds: inputBatch.map((input) => input.productId),
            failureKind: terminalKind,
            occurredAt,
            details: {
              reservationId,
              message: providerError.message.slice(0, 500),
            },
          });
        }
      });
      transaction.immediate();
      if (!shapeFailure) throw error;
      shapeFailedBatches += 1;
      shapeFailedProducts += inputBatch.length;
      failureSpendRunUsd = failureSpendRunUsd.plus(settledFailureCost);
      estimatedCostUsd = estimatedCostUsd.plus(settledFailureCost);
      if (shapeFailedBatches >= MAX_RUN_SHAPE_FAILURES) {
        shapeFailurePaused = true;
      }
      replenish();
      continue;
    }
    try {
      validateBatchResult(inputBatch, providerResult);
    } catch (error) {
      const validationAttempt: ClassificationAttemptEvidence = {
        provider: providerResult.provider,
        requestedModel: model,
        actualModel: providerResult.model,
        responseId: null,
        attempt: (providerResult.failedAttempts?.length ?? 0) + 1,
        inputTokens: providerResult.usage.inputTokens,
        outputTokens: providerResult.usage.outputTokens,
        failureKind: "validation_failed",
      };
      const occurredAt = now().toISOString();
      let settledFailureCost = 0;
      const transaction = dependencies.database.transaction(() => {
        settledFailureCost = persistFailureAttempts(
          dependencies.database,
          [...(providerResult.failedAttempts ?? []), validationAttempt],
          budgetGuard,
          {
            occurredAt,
            productIds: inputBatch.map((input) => input.productId),
            version,
            classificationReservationId: reservationId,
          },
        );
        settleSynchronousClassificationBudget(dependencies.database, {
          reservationId,
          actualCostUsd: settledFailureCost,
          settledAt: occurredAt,
          status: "settled",
          details: { responseValidationFailed: true },
        });
        recordClassificationShapeFailure(dependencies.database, {
          version,
          model,
          productIds: inputBatch.map((input) => input.productId),
          failureKind: "validation_failed",
          occurredAt,
          details: {
            reservationId,
            message: error instanceof Error
              ? error.message.slice(0, 500)
              : "batch result validation failed",
          },
        });
      });
      transaction.immediate();
      shapeFailedBatches += 1;
      shapeFailedProducts += inputBatch.length;
      failureSpendRunUsd = failureSpendRunUsd.plus(settledFailureCost);
      estimatedCostUsd = estimatedCostUsd.plus(settledFailureCost);
      if (shapeFailedBatches >= MAX_RUN_SHAPE_FAILURES) {
        shapeFailurePaused = true;
      }
      replenish();
      continue;
    }
    const actualCost = budgetGuard.estimateModelCost({
      model: providerResult.model,
      inputTokens: providerResult.usage.inputTokens,
      outputTokens: providerResult.usage.outputTokens,
    });
    const occurredAt = now().toISOString();
    let batchUnclassified = 0;
    let failedAttemptCost = 0;
    try {
      const transaction = dependencies.database.transaction(() => {
        failedAttemptCost = persistFailureAttempts(
          dependencies.database,
          providerResult.failedAttempts ?? [],
          budgetGuard,
          {
            occurredAt,
            productIds: inputBatch.map((input) => input.productId),
            version,
            classificationReservationId: reservationId,
          },
        );
        batchUnclassified = persistClassificationBatch(
          dependencies.database,
          inputBatch,
          productById,
          providerResult,
          threshold,
          version,
          occurredAt,
          actualCost,
          reservationId,
        );
        settleSynchronousClassificationBudget(dependencies.database, {
          reservationId,
          actualCostUsd: actualCost + failedAttemptCost,
          settledAt: occurredAt,
          status: "settled",
          details: {
            classifications: inputBatch.length,
            failedAttemptCostUsd: failedAttemptCost,
          },
        });
      });
      transaction.immediate();
    } catch (error) {
      if (!uniqueClassificationConflict(error)) throw error;
      const duplicateAttempt: ClassificationAttemptEvidence = {
        provider: providerResult.provider,
        requestedModel: model,
        actualModel: providerResult.model,
        responseId: null,
        attempt: (providerResult.failedAttempts?.length ?? 0) + 1,
        inputTokens: providerResult.usage.inputTokens,
        outputTokens: providerResult.usage.outputTokens,
        failureKind: "duplicate_conflict",
      };
      const transaction = dependencies.database.transaction(() => {
        const cost = persistFailureAttempts(
          dependencies.database,
          [...(providerResult.failedAttempts ?? []), duplicateAttempt],
          budgetGuard,
          {
            occurredAt,
            productIds: inputBatch.map((input) => input.productId),
            version,
            classificationReservationId: reservationId,
          },
        );
        settleSynchronousClassificationBudget(dependencies.database, {
          reservationId,
          actualCostUsd: cost,
          settledAt: occurredAt,
          status: "settled",
          details: { duplicateConflict: true },
        });
        return cost;
      });
      failedAttemptCost = transaction.immediate();
      estimatedCostUsd = estimatedCostUsd.plus(failedAttemptCost);
      failureSpendRunUsd = failureSpendRunUsd.plus(failedAttemptCost);
      replenish();
      continue;
    }
    unclassified += batchUnclassified;
    batches += 1;
    classified += inputBatch.length;
    estimatedCostUsd = estimatedCostUsd.plus(actualCost).plus(failedAttemptCost);
    failureSpendRunUsd = failureSpendRunUsd.plus(failedAttemptCost);
    replenish();
  }

  return {
    ...base,
    status: budgetDenied > 0
      ? "budget_denied"
      : shapeFailurePaused
        ? "shape_failure_paused"
        : "completed",
    plannedBatches: plan.length,
    batches,
    classified,
    unclassified,
    pending: products.length - classified,
    budgetDenied,
    estimatedCostUsd: estimatedCostUsd.toDecimalPlaces(12).toNumber(),
    shapeFailedBatches,
    shapeFailedProducts,
    shapeFailurePaused,
    quarantinedActive: quarantinedEligible.length,
    quarantinedNew: newlyQuarantined.length,
    quarantinedProductIds: quarantinedEligible,
    failureSpendRunUsd: failureSpendRunUsd.toDecimalPlaces(12).toNumber(),
    failureSpendMonthUsd: classificationFailureSpendMonthUsd(
      dependencies.database,
      now(),
    ),
  };
}

export interface ReviewSampleRow {
  productId: string;
  title: string;
  brand: string | null;
  sourceCategory: string | null;
  ipcaItemId: string | null;
  ipcaCode: string | null;
  ipcaName: string | null;
  confidence: number;
  classificationVersion: number;
}

interface ReviewRow {
  product_id: string;
  title: string;
  brand: string | null;
  source_category: string | null;
  ipca_item_id: string | null;
  code: string | null;
  name: string | null;
  confidence: number;
  version: number;
}

export function buildReviewSample(
  database: Database.Database,
  options: { limit: number; version: number },
): ReviewSampleRow[] {
  const limit = Math.min(positiveInteger("review sample limit", options.limit, 100_000), 200);
  const version = positiveInteger("review sample version", options.version, 1_000_000);
  const rows = database.prepare(
    `SELECT p.id AS product_id, p.title, p.brand, p.source_category,
            c.ipca_item_id, i.code, i.name, c.confidence, c.version
     FROM classifications c
     JOIN products p ON p.id = c.product_id
     LEFT JOIN ipca_items i ON i.id = c.ipca_item_id
     WHERE c.version = ?
     ORDER BY p.id`,
  ).all(version) as ReviewRow[];
  const strata = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    const key = row.ipca_item_id ?? "unclassified";
    const group = strata.get(key) ?? [];
    group.push(row);
    strata.set(key, group);
  }
  const ranked = [...strata.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, group]) => group.sort((left, right) => {
      const leftHash = createHash("sha256").update(`${version}:${left.product_id}`).digest("hex");
      const rightHash = createHash("sha256").update(`${version}:${right.product_id}`).digest("hex");
      return leftHash.localeCompare(rightHash, "en");
    }));
  const selected: ReviewRow[] = [];
  for (let index = 0; selected.length < limit; index += 1) {
    let added = false;
    for (const group of ranked) {
      const row = group[index];
      if (row !== undefined && selected.length < limit) {
        selected.push(row);
        added = true;
      }
    }
    if (!added) break;
  }
  return selected.map((row) => ({
    productId: row.product_id,
    title: row.title,
    brand: row.brand,
    sourceCategory: row.source_category,
    ipcaItemId: row.ipca_item_id,
    ipcaCode: row.code,
    ipcaName: row.name,
    confidence: row.confidence,
    classificationVersion: row.version,
  }));
}
