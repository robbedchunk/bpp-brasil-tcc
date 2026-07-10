import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";

import { BudgetGuard } from "../ops/budget.js";
import { DEFAULT_CLASSIFICATION_MODEL } from "./openai-provider.js";
import { ClassificationProviderError } from "./provider.js";
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
}

export type ClassificationRunStatus =
  | "completed"
  | "dry_run"
  | "provider_unavailable"
  | "budget_denied"
  | "no_ipca_items";

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
}

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
  return database.prepare(
    `SELECT p.id, p.retailer_id, p.title, p.brand, p.source_category
     FROM products p
     WHERE p.active = 1
       AND p.in_scope = 1
       AND NOT EXISTS (
         SELECT 1 FROM classifications c
         WHERE c.product_id = p.id AND c.version = ?
       )
     ORDER BY p.id`,
  ).all(version) as ClassificationProduct[];
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
      (id, category, retailer_id, classification_id, provider, model,
       input_tokens, output_tokens, cost_usd, occurred_at, details_json)
    VALUES
      (?, 'classification', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  },
): number {
  const insert = database.prepare(`
    INSERT INTO cost_ledger
      (id, category, provider, model, input_tokens, output_tokens,
       cost_usd, occurred_at, details_json)
    VALUES
      (?, 'classification_failure', ?, ?, ?, ?, ?, ?, ?)
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

function uniqueClassificationConflict(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && error.code.startsWith("SQLITE_CONSTRAINT_UNIQUE");
}

function monthSpend(database: Database.Database, now: Date): number {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const row = database.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost
     FROM cost_ledger
     WHERE occurred_at >= ? AND occurred_at < ?`,
  ).get(monthStart, nextMonth) as { cost: number };
  return row.cost;
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
  const version = positiveInteger("version", options.version, 1_000_000);
  const threshold = confidence(options.confidenceThreshold);
  const dryRun = options.dryRun === true;
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
  };
  if (dryRun) return { ...base, status: "dry_run" };
  if (products.length === 0) return { ...base, status: "completed" };
  if (allowedItems.length === 0) return { ...base, status: "no_ipca_items" };
  if (dependencies.provider === undefined) {
    return { ...base, status: "provider_unavailable" };
  }

  const budgetGuard = dependencies.budgetGuard ?? new BudgetGuard();
  const model = dependencies.classificationModel ?? DEFAULT_CLASSIFICATION_MODEL;
  const now = dependencies.now ?? (() => new Date());
  const productById = new Map(products.map((product) => [product.id, product]));
  let currentSpend = monthSpend(dependencies.database, now());
  let batches = 0;
  let classified = 0;
  let unclassified = 0;
  let budgetDenied = 0;
  let estimatedCostUsd = new Decimal(0);

  for (let offset = 0; offset < products.length; offset += batchSize) {
    const productBatch = products.slice(offset, offset + batchSize);
    const inputBatch = productBatch.map((product) => inputFor(product, allowedItems));
    const projectedCost = budgetGuard.estimateModelCost({
      model,
      ...plannedUsage(inputBatch),
    });
    if (budgetGuard.decide({
      projectedMonthlyUsd: currentSpend + projectedCost,
      essential: false,
    }) === "pause") {
      budgetDenied = products.length - offset;
      break;
    }

    let providerResult: ClassificationBatchResult;
    try {
      providerResult = await dependencies.provider.classify(inputBatch);
    } catch (error) {
      if (error instanceof ClassificationProviderError && error.attempts.length > 0) {
        const occurredAt = now().toISOString();
        const transaction = dependencies.database.transaction(() =>
          persistFailureAttempts(
            dependencies.database,
            error.attempts,
            budgetGuard,
            {
              occurredAt,
              productIds: inputBatch.map((input) => input.productId),
              version,
            },
          ));
        transaction.immediate();
      }
      throw error;
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
      const transaction = dependencies.database.transaction(() =>
        persistFailureAttempts(
          dependencies.database,
          [...(providerResult.failedAttempts ?? []), validationAttempt],
          budgetGuard,
          {
            occurredAt,
            productIds: inputBatch.map((input) => input.productId),
            version,
          },
        ));
      transaction.immediate();
      throw error;
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
        );
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
      const transaction = dependencies.database.transaction(() =>
        persistFailureAttempts(
          dependencies.database,
          [...(providerResult.failedAttempts ?? []), duplicateAttempt],
          budgetGuard,
          {
            occurredAt,
            productIds: inputBatch.map((input) => input.productId),
            version,
          },
        ));
      failedAttemptCost = transaction.immediate();
      currentSpend += failedAttemptCost;
      estimatedCostUsd = estimatedCostUsd.plus(failedAttemptCost);
      continue;
    }
    unclassified += batchUnclassified;
    batches += 1;
    classified += inputBatch.length;
    currentSpend += actualCost + failedAttemptCost;
    estimatedCostUsd = estimatedCostUsd.plus(actualCost).plus(failedAttemptCost);
  }

  return {
    ...base,
    status: budgetDenied > 0 ? "budget_denied" : "completed",
    batches,
    classified,
    unclassified,
    pending: products.length - classified,
    budgetDenied,
    estimatedCostUsd: estimatedCostUsd.toDecimalPlaces(12).toNumber(),
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
