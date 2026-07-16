import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  BudgetGuard,
  RELEASED_CLASSIFICATION_BATCH_STATUSES,
  classificationMonthlyCommittedUsd,
} from "../ops/budget.js";
import {
  persistClassificationBatch,
  persistFailureAttempts,
  type ClassificationProduct,
} from "./classify.js";
import {
  ClassificationResponseSchema,
  isTransientOpenAIError,
} from "./openai-provider.js";
import {
  CLASSIFICATION_INSTRUCTIONS,
  CLASSIFICATION_PROMPT_HASH,
  CLASSIFICATION_PROMPT_VERSION,
  buildClassificationPrompt,
} from "./prompt.js";
import type {
  AllowedIpcaItem,
  ClassificationAttemptEvidence,
  ClassificationBatchResult,
  ClassificationInput,
} from "./provider.js";

interface UploadableText {
  text(): Promise<string>;
}

export interface RemoteBatch {
  id: string;
  status: string;
  input_file_id: string;
  output_file_id?: string;
  error_file_id?: string;
  model?: string;
  request_counts?: {
    total: number;
    completed: number;
    failed: number;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  metadata?: Record<string, string> | null;
  errors?: {
    data?: unknown[];
  } | null;
  [key: string]: unknown;
}

export interface OpenAIBatchClient {
  files: {
    create(body: { file: UploadableText; purpose: "batch" }): Promise<{ id: string }>;
    content(fileId: string): Promise<{ text(): Promise<string> }>;
  };
  batches: {
    create(body: {
      input_file_id: string;
      endpoint: "/v1/responses";
      completion_window: "24h";
      metadata: Record<string, string>;
    }, options?: { idempotencyKey?: string }): Promise<RemoteBatch>;
    retrieve(batchId: string): Promise<RemoteBatch>;
    list(query?: { limit?: number }): Promise<{ data: RemoteBatch[] }>;
  };
}

export function createOpenAIBatchClient(apiKey: string): OpenAIBatchClient {
  return new OpenAI({ apiKey, maxRetries: 0 }) as unknown as OpenAIBatchClient;
}

export interface ClassificationBatchOptions {
  version: number;
  confidenceThreshold: number;
  limit?: number;
}

export interface ClassificationBatchDependencies {
  database: Database.Database;
  client?: OpenAIBatchClient;
  budgetGuard?: BudgetGuard;
  model: string;
  now?: () => Date;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface BatchSubmissionSummary {
  status: "completed" | "provider_unavailable" | "budget_denied" | "no_ipca_items" | "submitted";
  jobId: string | null;
  providerBatchId: string | null;
  eligible: number;
  submitted: number;
  pending: number;
}

export interface BatchPollSummary {
  jobId: string;
  status: string;
  completed: number;
  failed: number;
  total: number;
}

export interface BatchFinalizeSummary {
  jobId: string;
  status: "finalized" | "finalized_partial" | "finalized_failed";
  classified: number;
  failed: number;
  pending: number;
}

interface JobRow {
  id: string;
  provider_batch_id: string | null;
  input_file_id: string | null;
  output_file_id: string | null;
  error_file_id: string | null;
  version: number;
  confidence_threshold: number;
  requested_model: string;
  actual_model: string | null;
  prompt_version: string;
  prompt_hash: string;
  status: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  input_tokens: number;
  output_tokens: number;
  projected_cost_usd: number;
  actual_cost_usd: number | null;
  provider_errors_json: string;
}

interface ItemRow {
  custom_id: string;
  product_id: string;
  input_json: string;
}

const AllowedItemSchema = z.object({
  id: z.string().min(1),
  code: z.string().regex(/^\d{7}$/u),
  name: z.string().min(1),
}).strict();

const StoredInputSchema = z.object({
  productId: z.string().min(1),
  title: z.string().min(1),
  brand: z.string().nullable(),
  sourceCategory: z.string().nullable(),
  allowedItems: z.array(AllowedItemSchema).min(1),
}).strict();

const BatchErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  param: z.unknown().optional(),
  type: z.unknown().optional(),
}).strict();

const BatchLineSchema = z.object({
  id: z.string().min(1),
  custom_id: z.string().min(1),
  response: z.object({
    status_code: z.number().int(),
    request_id: z.string().nullable(),
    body: z.unknown(),
  }).strict().nullable(),
  error: BatchErrorSchema.nullable(),
}).strict();

const ResponseBodySchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  model: z.string().min(1),
  output: z.array(z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

const TERMINAL_REMOTE_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function threshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("confidenceThreshold must be between 0 and 1");
  }
  return value;
}

function listAllowedItems(database: Database.Database): AllowedIpcaItem[] {
  return database.prepare(`
    SELECT id, code, name FROM ipca_items
    WHERE in_scope = 1 AND item_group = 'alimentacao_no_domicilio'
    ORDER BY code, id
  `).all() as AllowedIpcaItem[];
}

function listEligibleProducts(
  database: Database.Database,
  version: number,
  limit: number,
): ClassificationProduct[] {
  const releasedPlaceholders = RELEASED_CLASSIFICATION_BATCH_STATUSES.map(() => "?").join(", ");
  return database.prepare(`
    SELECT p.id, p.retailer_id, p.title, p.brand, p.source_category
    FROM products p
    WHERE p.active = 1 AND p.in_scope = 1 AND p.descriptive_title = 1
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
    ORDER BY p.id
    LIMIT ?
  `).all(
    version,
    version,
    ...RELEASED_CLASSIFICATION_BATCH_STATUSES,
    limit,
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

function providerErrors(remote: RemoteBatch): Array<Record<string, unknown>> {
  if (!Array.isArray(remote.errors?.data)) return [];
  return remote.errors.data.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const error: Record<string, unknown> = {};
    if ("code" in value && typeof value.code === "string") {
      error.code = value.code.slice(0, 200);
    }
    if ("line" in value && Number.isSafeInteger(value.line) && Number(value.line) >= 0) {
      error.line = Number(value.line);
    }
    if ("message" in value && typeof value.message === "string") {
      error.message = value.message.slice(0, 500);
    }
    if (
      "param" in value
      && (typeof value.param === "string" || value.param === null)
    ) error.param = value.param;
    return Object.keys(error).length === 0 ? [] : [error];
  });
}

function mergedProviderErrors(
  currentJson: string,
  incoming: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  let current: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(currentJson) as unknown;
    if (Array.isArray(parsed)) {
      current = parsed.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      );
    }
  } catch {
    current = [];
  }
  const unique = new Map<string, Record<string, unknown>>();
  for (const error of [...current, ...incoming]) unique.set(JSON.stringify(error), error);
  return [...unique.values()];
}

function safeRemote(remote: RemoteBatch): Record<string, unknown> {
  return {
    id: remote.id,
    status: remote.status,
    inputFileId: remote.input_file_id,
    outputFileId: remote.output_file_id ?? null,
    errorFileId: remote.error_file_id ?? null,
    model: remote.model ?? null,
    requestCounts: remote.request_counts ?? null,
    usage: remote.usage === undefined ? null : {
      inputTokens: remote.usage.input_tokens,
      outputTokens: remote.usage.output_tokens,
    },
    errors: providerErrors(remote),
  };
}

function safeError(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return { message: "unknown error" };
  const diagnostic: Record<string, unknown> = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
  };
  if ("status" in error && Number.isSafeInteger(Number(error.status))) {
    diagnostic.status = Number(error.status);
  }
  if ("code" in error && typeof error.code === "string") {
    diagnostic.code = error.code.slice(0, 100);
  }
  return diagnostic;
}

function retryAttempts(dependencies: ClassificationBatchDependencies): number {
  const attempts = dependencies.maxAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new RangeError("maxAttempts must be an integer from 1 to 5");
  }
  return attempts;
}

function sleeper(dependencies: ClassificationBatchDependencies): (milliseconds: number) => Promise<void> {
  return dependencies.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
}

async function retryTransient<T>(
  operation: () => Promise<T>,
  dependencies: ClassificationBatchDependencies,
): Promise<T> {
  const maxAttempts = retryAttempts(dependencies);
  const sleep = sleeper(dependencies);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientOpenAIError(error) || attempt === maxAttempts) throw error;
      await sleep(250 * (2 ** (attempt - 1)));
    }
  }
  throw new Error("Transient retry loop ended unexpectedly");
}

function insertEvent(
  database: Database.Database,
  input: {
    id?: string;
    jobId: string;
    status: string;
    provider: unknown;
    occurredAt: string;
  },
): void {
  database.prepare(`
    INSERT INTO classification_batch_events
      (id, job_id, status, provider_json, occurred_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.id ?? randomUUID(),
    input.jobId,
    input.status,
    JSON.stringify(input.provider),
    input.occurredAt,
  );
}

function job(database: Database.Database, jobId: string): JobRow {
  const row = database.prepare(`
    SELECT id, provider_batch_id, input_file_id, output_file_id, error_file_id,
           version, confidence_threshold, requested_model, actual_model,
           prompt_version, prompt_hash, status, total_items, completed_items,
           failed_items, input_tokens, output_tokens, projected_cost_usd,
           actual_cost_usd, provider_errors_json
    FROM classification_batch_jobs WHERE id = ?
  `).get(jobId) as JobRow | undefined;
  if (row === undefined) throw new Error(`Unknown classification batch job: ${jobId}`);
  return row;
}

function customId(version: number, productId: string): string {
  return `cls-${createHash("sha256").update(`${version}:${productId}`).digest("hex").slice(0, 40)}`;
}

function batchRequest(input: ClassificationInput, model: string): Record<string, unknown> {
  return {
    custom_id: customId(0, input.productId),
    method: "POST",
    url: "/v1/responses",
    body: {
      model,
      store: false,
      instructions: CLASSIFICATION_INSTRUCTIONS,
      input: buildClassificationPrompt([input]),
      text: {
        format: zodTextFormat(
          ClassificationResponseSchema,
          "ipca_product_classifications",
        ),
      },
    },
  };
}

interface BatchCreateBody {
  input_file_id: string;
  endpoint: "/v1/responses";
  completion_window: "24h";
  metadata: Record<string, string>;
}

class BatchSubmissionUnknownError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "BatchSubmissionUnknownError";
  }
}

async function createBatchWithReconciliation(
  client: OpenAIBatchClient,
  body: BatchCreateBody,
  jobId: string,
  dependencies: ClassificationBatchDependencies,
): Promise<RemoteBatch> {
  const maxAttempts = retryAttempts(dependencies);
  const sleep = sleeper(dependencies);
  let ambiguous = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.batches.create(body, {
        idempotencyKey: `classification-batch-${jobId}`,
      });
    } catch (error) {
      if (!isTransientOpenAIError(error)) {
        if (ambiguous) {
          throw new BatchSubmissionUnknownError(
            "Batch creation is ambiguous after an earlier lost response",
            error,
          );
        }
        throw error;
      }
      ambiguous = true;
      let page: { data: RemoteBatch[] };
      try {
        page = await retryTransient(
          () => client.batches.list({ limit: 100 }),
          dependencies,
        );
      } catch (reconciliationError) {
        throw new BatchSubmissionUnknownError(
          "Batch creation response was lost and metadata reconciliation failed",
          reconciliationError,
        );
      }
      const reconciled = page.data.find(
        (remote) => remote.metadata?.local_job_id === jobId,
      );
      if (reconciled !== undefined) return reconciled;
      if (attempt === maxAttempts) {
        throw new BatchSubmissionUnknownError(
          "Batch creation response was lost and no matching remote metadata was found",
          error,
        );
      }
      await sleep(250 * (2 ** (attempt - 1)));
    }
  }
  throw new Error("Batch creation retry loop ended unexpectedly");
}

function recordSubmissionFailure(
  database: Database.Database,
  input: {
    jobId: string;
    status: "submission_released" | "submission_unknown";
    phase: "upload" | "create";
    error: unknown;
    occurredAt: string;
  },
): void {
  const persist = database.transaction(() => {
    database.prepare(`
      UPDATE classification_batch_jobs
      SET status = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.status,
      input.error instanceof Error
        ? input.error.message.slice(0, 500)
        : `${input.phase} failed`,
      input.occurredAt,
      input.jobId,
    );
    insertEvent(database, {
      id: `${input.jobId}:0002`,
      jobId: input.jobId,
      status: input.status,
      provider: { phase: input.phase, error: safeError(input.error) },
      occurredAt: input.occurredAt,
    });
  });
  persist.immediate();
}

export interface SubmissionReconcileResult {
  jobId: string;
  outcome: "adopted" | "released" | "unresolved";
  providerBatchId: string | null;
}

/** How many recent remote batches one reconciliation pass inspects. A missing
 * match only proves absence when the provider returned fewer entries than
 * this, so releases stay fail-closed. */
export const SUBMISSION_RECONCILE_LIST_LIMIT = 100;

/**
 * Deterministically settles `submission_unknown` jobs, which otherwise hold
 * their products and projected budget forever. The provider's batch list is
 * the source of truth:
 * - a remote batch whose metadata carries the local job ID is adopted as
 *   `submitted`, so poll/finalize can complete it and its bill stays counted;
 * - a confirmed absence (the listing was exhaustive) releases the job, which
 *   frees the committed budget and returns its products to eligibility;
 * - anything unconfirmed stays `submission_unknown` with its claim intact.
 */
export async function reconcileUnknownSubmissions(
  dependencies: ClassificationBatchDependencies,
): Promise<SubmissionReconcileResult[]> {
  const jobs = dependencies.database.prepare(`
    SELECT id FROM classification_batch_jobs
    WHERE status = 'submission_unknown'
    ORDER BY created_at, id
  `).all() as Array<{ id: string }>;
  if (jobs.length === 0) return [];
  if (dependencies.client === undefined) {
    return jobs.map(({ id }) => ({
      jobId: id,
      outcome: "unresolved",
      providerBatchId: null,
    }));
  }
  const client = dependencies.client;
  const now = dependencies.now ?? (() => new Date());
  const page = await retryTransient(
    () => client.batches.list({ limit: SUBMISSION_RECONCILE_LIST_LIMIT }),
    dependencies,
  );
  const listingWasExhaustive = page.data.length < SUBMISSION_RECONCILE_LIST_LIMIT;
  const remoteByLocalJob = new Map(
    page.data.flatMap((remote) => {
      const localJobId = remote.metadata?.local_job_id;
      return typeof localJobId === "string" && localJobId.length > 0
        ? [[localJobId, remote] as const]
        : [];
    }),
  );
  const results: SubmissionReconcileResult[] = [];
  for (const { id: jobId } of jobs) {
    const remote = remoteByLocalJob.get(jobId);
    const occurredAt = now().toISOString();
    if (remote !== undefined) {
      const current = job(dependencies.database, jobId);
      const adopt = dependencies.database.transaction(() => {
        const updated = dependencies.database.prepare(`
          UPDATE classification_batch_jobs
          SET provider_batch_id = ?, input_file_id = ?, status = 'submitted',
              submitted_at = ?, updated_at = ?, actual_model = ?,
              provider_errors_json = ?, error_message = NULL
          WHERE id = ? AND status = 'submission_unknown'
        `).run(
          remote.id,
          remote.input_file_id,
          occurredAt,
          occurredAt,
          remote.model ?? current.actual_model,
          JSON.stringify(mergedProviderErrors(
            current.provider_errors_json,
            providerErrors(remote),
          )),
          jobId,
        );
        if (updated.changes !== 1) {
          throw new Error(`Unknown submission ${jobId} changed during reconciliation`);
        }
        insertEvent(dependencies.database, {
          jobId,
          status: "submitted",
          provider: { ...safeRemote(remote), reconciledFromUnknown: true },
          occurredAt,
        });
      });
      adopt.immediate();
      results.push({ jobId, outcome: "adopted", providerBatchId: remote.id });
      continue;
    }
    if (!listingWasExhaustive) {
      results.push({ jobId, outcome: "unresolved", providerBatchId: null });
      continue;
    }
    const release = dependencies.database.transaction(() => {
      const updated = dependencies.database.prepare(`
        UPDATE classification_batch_jobs
        SET status = 'submission_released', updated_at = ?, error_message = ?
        WHERE id = ? AND status = 'submission_unknown'
      `).run(
        occurredAt,
        "reconciled: provider listing confirmed no matching remote batch",
        jobId,
      );
      if (updated.changes !== 1) {
        throw new Error(`Unknown submission ${jobId} changed during reconciliation`);
      }
      insertEvent(dependencies.database, {
        jobId,
        status: "submission_released",
        provider: {
          reconciledFromUnknown: true,
          remoteBatchesInspected: page.data.length,
        },
        occurredAt,
      });
    });
    release.immediate();
    results.push({ jobId, outcome: "released", providerBatchId: null });
  }
  return results;
}

export async function submitClassificationBatch(
  options: ClassificationBatchOptions,
  dependencies: ClassificationBatchDependencies,
): Promise<BatchSubmissionSummary> {
  const version = positiveInteger("version", options.version, 1_000_000);
  const confidenceThreshold = threshold(options.confidenceThreshold);
  const limit = positiveInteger("limit", options.limit ?? 50_000, 50_000);
  // Settle any prior ambiguous submission first: it may free (or confirm)
  // held products and committed budget before eligibility is computed.
  await reconcileUnknownSubmissions(dependencies);
  const products = listEligibleProducts(dependencies.database, version, limit);
  const base = {
    jobId: null,
    providerBatchId: null,
    eligible: products.length,
    submitted: 0,
    pending: products.length,
  };
  if (products.length === 0) return { ...base, status: "completed" };
  const allowedItems = listAllowedItems(dependencies.database);
  if (allowedItems.length === 0) return { ...base, status: "no_ipca_items" };
  if (dependencies.client === undefined) return { ...base, status: "provider_unavailable" };

  const budgetGuard = dependencies.budgetGuard ?? BudgetGuard.fromEnv();
  const now = dependencies.now ?? (() => new Date());
  const inputs = products.map((product) => inputFor(product, allowedItems));
  const projected = budgetGuard.estimateModelCost({
    model: dependencies.model,
    inputTokens: Math.max(1, Math.ceil(JSON.stringify(inputs).length / 3)),
    outputTokens: Math.max(1, inputs.length * 80),
  });
  if (budgetGuard.decide({
    projectedMonthlyUsd:
      classificationMonthlyCommittedUsd(dependencies.database, now()) + projected,
    essential: false,
  }) === "pause") return { ...base, status: "budget_denied" };

  const jobId = randomUUID();
  const requests = inputs.map((input) => ({
    ...batchRequest(input, dependencies.model),
    custom_id: customId(version, input.productId),
  }));
  const jsonl = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
  const inputHash = createHash("sha256").update(jsonl).digest("hex");
  const createdAt = now().toISOString();
  const prepare = dependencies.database.transaction(() => {
    dependencies.database.prepare(`
      INSERT INTO classification_batch_jobs
        (id, provider, version, confidence_threshold, requested_model,
         prompt_version, prompt_hash, input_sha256, status, total_items,
         projected_cost_usd, created_at, updated_at)
      VALUES (?, 'openai', ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?)
    `).run(
      jobId,
      version,
      confidenceThreshold,
      dependencies.model,
      CLASSIFICATION_PROMPT_VERSION,
      CLASSIFICATION_PROMPT_HASH,
      inputHash,
      products.length,
      projected,
      createdAt,
      createdAt,
    );
    const insertItem = dependencies.database.prepare(`
      INSERT INTO classification_batch_items
        (id, job_id, custom_id, product_id, input_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    inputs.forEach((input, index) => insertItem.run(
      randomUUID(),
      jobId,
      requests[index]?.custom_id,
      input.productId,
      JSON.stringify(input),
      createdAt,
    ));
    insertEvent(dependencies.database, {
      id: `${jobId}:0001`,
      jobId,
      status: "preparing",
      provider: {},
      occurredAt: createdAt,
    });
  });
  prepare.immediate();

  let uploaded: { id: string };
  try {
    const file = await toFile(
      Buffer.from(jsonl, "utf8"),
      `ipca-classification-v${version}.jsonl`,
      { type: "application/jsonl" },
    ) as unknown as UploadableText;
    uploaded = await retryTransient(
      () => dependencies.client!.files.create({ file, purpose: "batch" }),
      dependencies,
    );
    dependencies.database.prepare(`
      UPDATE classification_batch_jobs SET input_file_id = ?, updated_at = ? WHERE id = ?
    `).run(uploaded.id, now().toISOString(), jobId);
  } catch (error) {
    recordSubmissionFailure(dependencies.database, {
      jobId,
      status: "submission_released",
      phase: "upload",
      error,
      occurredAt: now().toISOString(),
    });
    throw error;
  }

  let remote: RemoteBatch;
  try {
    remote = await createBatchWithReconciliation(dependencies.client, {
      input_file_id: uploaded.id,
      endpoint: "/v1/responses",
      completion_window: "24h",
      metadata: { local_job_id: jobId, classification_version: String(version) },
    }, jobId, dependencies);
  } catch (error) {
    recordSubmissionFailure(dependencies.database, {
      jobId,
      status: error instanceof BatchSubmissionUnknownError
        ? "submission_unknown"
        : "submission_released",
      phase: "create",
      error,
      occurredAt: now().toISOString(),
    });
    throw error;
  }

  try {
    const submittedAt = now().toISOString();
    const persist = dependencies.database.transaction(() => {
      dependencies.database.prepare(`
        UPDATE classification_batch_jobs
        SET provider_batch_id = ?, input_file_id = ?, status = 'submitted',
            submitted_at = ?, updated_at = ?, actual_model = ?,
            provider_errors_json = ?
        WHERE id = ?
      `).run(
        remote.id,
        remote.input_file_id,
        submittedAt,
        submittedAt,
        remote.model ?? null,
        JSON.stringify(providerErrors(remote)),
        jobId,
      );
      insertEvent(dependencies.database, {
        id: `${jobId}:0002`,
        jobId,
        status: "submitted",
        provider: safeRemote(remote),
        occurredAt: submittedAt,
      });
    });
    persist.immediate();
    return {
      status: "submitted",
      jobId,
      providerBatchId: remote.id,
      eligible: products.length,
      submitted: products.length,
      pending: products.length,
    };
  } catch (error) {
    // The remote Batch exists. Leaving the preparing claim active prevents a
    // second bill if local persistence fails after provider creation.
    throw error;
  }
}

export async function pollClassificationBatch(
  jobId: string,
  dependencies: ClassificationBatchDependencies,
): Promise<BatchPollSummary> {
  const current = job(dependencies.database, jobId);
  if (dependencies.client === undefined) throw new Error("OpenAI Batch client is unavailable");
  if (current.provider_batch_id === null) throw new Error(`Batch job ${jobId} was not submitted`);
  const remote = await retryTransient(
    () => dependencies.client!.batches.retrieve(current.provider_batch_id!),
    dependencies,
  );
  if (remote.id !== current.provider_batch_id) throw new Error("Retrieved the wrong provider batch");
  const counts = remote.request_counts ?? {
    total: current.total_items,
    completed: current.completed_items,
    failed: current.failed_items,
  };
  if (
    !Number.isSafeInteger(counts.total)
    || !Number.isSafeInteger(counts.completed)
    || !Number.isSafeInteger(counts.failed)
    || counts.total !== current.total_items
    || counts.completed < 0
    || counts.failed < 0
    || counts.completed + counts.failed > counts.total
  ) throw new Error("Invalid provider batch request counts");
  const inputTokens = remote.usage?.input_tokens ?? current.input_tokens;
  const outputTokens = remote.usage?.output_tokens ?? current.output_tokens;
  if (
    !Number.isSafeInteger(inputTokens)
    || inputTokens < 0
    || !Number.isSafeInteger(outputTokens)
    || outputTokens < 0
  ) throw new Error("Invalid provider batch token usage");
  const actualCost = remote.usage === undefined
    ? current.actual_cost_usd
    : (dependencies.budgetGuard ?? new BudgetGuard()).estimateModelCost({
        model: remote.model ?? current.actual_model ?? current.requested_model,
        inputTokens,
        outputTokens,
      });
  const errors = mergedProviderErrors(current.provider_errors_json, providerErrors(remote));
  const occurredAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const persist = dependencies.database.transaction(() => {
    dependencies.database.prepare(`
      UPDATE classification_batch_jobs
      SET status = ?, output_file_id = ?, error_file_id = ?, actual_model = ?,
          completed_items = ?, failed_items = ?, input_tokens = ?, output_tokens = ?,
          actual_cost_usd = ?, provider_errors_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      remote.status,
      remote.output_file_id ?? null,
      remote.error_file_id ?? null,
      remote.model ?? current.actual_model,
      counts.completed,
      counts.failed,
      inputTokens,
      outputTokens,
      actualCost,
      JSON.stringify(errors),
      occurredAt,
      jobId,
    );
    insertEvent(dependencies.database, {
      jobId,
      status: remote.status,
      provider: safeRemote(remote),
      occurredAt,
    });
  });
  persist.immediate();
  return {
    jobId,
    status: remote.status,
    completed: counts.completed,
    failed: counts.failed,
    total: counts.total,
  };
}

function parseJsonl(text: string): unknown[] {
  return text.split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function outputText(output: unknown[]): string {
  const texts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null || !("content" in item)) continue;
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        typeof content === "object"
        && content !== null
        && "type" in content
        && content.type === "output_text"
        && "text" in content
        && typeof content.text === "string"
      ) texts.push(content.text);
    }
  }
  if (texts.length !== 1) throw new Error("Batch response must contain exactly one output_text");
  return texts[0] ?? "";
}

function pendingForJob(database: Database.Database, row: JobRow): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count
    FROM classification_batch_items bi
    WHERE bi.job_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM classifications c
        WHERE c.product_id = bi.product_id AND c.version = ?
      )
  `).get(row.id, row.version) as { count: number }).count;
}

function finalizedSummary(database: Database.Database, row: JobRow): BatchFinalizeSummary {
  return {
    jobId: row.id,
    status: row.status as BatchFinalizeSummary["status"],
    classified: row.completed_items,
    failed: row.failed_items,
    pending: pendingForJob(database, row),
  };
}

function failureAttemptForJob(row: JobRow, failureKind: string): ClassificationAttemptEvidence[] {
  if (row.input_tokens === 0 && row.output_tokens === 0) return [];
  return [{
    provider: "openai",
    requestedModel: row.requested_model,
    actualModel: row.actual_model ?? row.requested_model,
    responseId: row.provider_batch_id,
    attempt: 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    failureKind,
  }];
}

function recordFinalizeFailure(
  database: Database.Database,
  row: JobRow,
  budgetGuard: BudgetGuard,
  now: Date,
  error: unknown,
): void {
  const occurredAt = now.toISOString();
  const items = database.prepare(`
    SELECT product_id FROM classification_batch_items WHERE job_id = ? ORDER BY product_id
  `).all(row.id) as Array<{ product_id: string }>;
  const alreadyRecorded = database.prepare(`
    SELECT 1 FROM cost_ledger
    WHERE category = 'classification_failure'
      AND json_extract(details_json, '$.batchJobId') = ?
    LIMIT 1
  `).get(row.id) !== undefined;
  const transaction = database.transaction(() => {
    if (!alreadyRecorded) {
      persistFailureAttempts(
        database,
        failureAttemptForJob(row, "batch_finalize_invalid"),
        budgetGuard,
        {
          occurredAt,
          productIds: items.map((item) => item.product_id),
          version: row.version,
          batchJobId: row.id,
        },
      );
    }
    database.prepare(`
      UPDATE classification_batch_jobs
      SET status = 'finalize_failed', failed_items = total_items,
          completed_items = 0, finalized_at = ?, updated_at = ?, error_message = ?
      WHERE id = ?
    `).run(
      occurredAt,
      occurredAt,
      error instanceof Error ? error.message.slice(0, 500) : "batch finalization failed",
      row.id,
    );
    insertEvent(database, {
      jobId: row.id,
      status: "finalize_failed",
      provider: {},
      occurredAt,
    });
  });
  transaction.immediate();
}

function recordFinalizeRetryable(
  database: Database.Database,
  row: JobRow,
  now: Date,
  error: unknown,
): void {
  const occurredAt = now.toISOString();
  const transaction = database.transaction(() => {
    database.prepare(`
      UPDATE classification_batch_jobs
      SET status = 'finalize_retryable', updated_at = ?, error_message = ?
      WHERE id = ?
    `).run(
      occurredAt,
      error instanceof Error ? error.message.slice(0, 500) : "retryable finalization failure",
      row.id,
    );
    insertEvent(database, {
      jobId: row.id,
      status: "finalize_retryable",
      provider: { error: safeError(error) },
      occurredAt,
    });
  });
  transaction.immediate();
}

async function downloadFileText(
  client: OpenAIBatchClient,
  fileId: string,
  dependencies: ClassificationBatchDependencies,
): Promise<string> {
  return retryTransient(async () => {
    const response = await client.files.content(fileId);
    return response.text();
  }, dependencies);
}

export async function finalizeClassificationBatch(
  jobId: string,
  dependencies: ClassificationBatchDependencies,
): Promise<BatchFinalizeSummary> {
  let current = job(dependencies.database, jobId);
  if (current.status.startsWith("finalized") || current.status === "finalize_failed") {
    return finalizedSummary(dependencies.database, current);
  }
  if (!TERMINAL_REMOTE_STATUSES.has(current.status)) {
    await pollClassificationBatch(jobId, dependencies);
    current = job(dependencies.database, jobId);
  }
  if (!TERMINAL_REMOTE_STATUSES.has(current.status)) {
    throw new Error(`Batch job ${jobId} is not terminal: ${current.status}`);
  }
  if (dependencies.client === undefined) throw new Error("OpenAI Batch client is unavailable");
  const budgetGuard = dependencies.budgetGuard ?? BudgetGuard.fromEnv();
  const now = dependencies.now ?? (() => new Date());

  try {
    const [outputFile, errorFile] = await Promise.all([
      current.output_file_id === null
        ? Promise.resolve("")
        : downloadFileText(dependencies.client, current.output_file_id, dependencies),
      current.error_file_id === null
        ? Promise.resolve("")
        : downloadFileText(dependencies.client, current.error_file_id, dependencies),
    ]);
    const lines = [...parseJsonl(outputFile), ...parseJsonl(errorFile)]
      .map((line) => BatchLineSchema.parse(line));
    const itemRows = dependencies.database.prepare(`
      SELECT custom_id, product_id, input_json
      FROM classification_batch_items WHERE job_id = ? ORDER BY product_id
    `).all(jobId) as ItemRow[];
    const itemByCustom = new Map(itemRows.map((item) => [item.custom_id, item]));
    const seen = new Set<string>();
    const successful: Array<{
      input: ClassificationInput;
      product: ClassificationProduct;
      result: ClassificationBatchResult;
    }> = [];
    let accountedInput = 0;
    let accountedOutput = 0;
    for (const line of lines) {
      const item = itemByCustom.get(line.custom_id);
      if (item === undefined || seen.has(line.custom_id)) {
        throw new Error(`Unknown or duplicate batch custom_id: ${line.custom_id}`);
      }
      seen.add(line.custom_id);
      if (line.response === null || line.error !== null) continue;
      if (line.response.status_code < 200 || line.response.status_code >= 300) continue;
      const body = ResponseBodySchema.parse(line.response.body);
      if (body.status !== "completed") throw new Error(`Batch response ${body.id} was ${body.status}`);
      const parsed = ClassificationResponseSchema.parse(JSON.parse(outputText(body.output)));
      const input = StoredInputSchema.parse(JSON.parse(item.input_json)) as ClassificationInput;
      if (parsed.results.length !== 1 || parsed.results[0]?.productId !== input.productId) {
        throw new Error(`Batch response does not match custom_id ${line.custom_id}`);
      }
      const product = dependencies.database.prepare(`
        SELECT id, retailer_id, title, brand, source_category FROM products WHERE id = ?
      `).get(item.product_id) as ClassificationProduct | undefined;
      if (product === undefined) throw new Error(`Missing batch product ${item.product_id}`);
      const result: ClassificationBatchResult = {
        provider: "openai",
        model: body.model,
        promptVersion: current.prompt_version,
        promptHash: current.prompt_hash,
        results: parsed.results,
        usage: {
          inputTokens: body.usage.input_tokens,
          outputTokens: body.usage.output_tokens,
        },
        failedAttempts: [],
      };
      accountedInput += result.usage.inputTokens;
      accountedOutput += result.usage.outputTokens;
      successful.push({ input, product, result });
    }
    if (accountedInput > current.input_tokens || accountedOutput > current.output_tokens) {
      throw new Error("Per-response usage exceeds the provider batch aggregate");
    }
    const residualInput = current.input_tokens - accountedInput;
    const residualOutput = current.output_tokens - accountedOutput;
    const failureAttempts: ClassificationAttemptEvidence[] =
      residualInput === 0 && residualOutput === 0
        ? []
        : [{
            provider: "openai",
            requestedModel: current.requested_model,
            actualModel: current.actual_model ?? current.requested_model,
            responseId: current.provider_batch_id,
            attempt: 1,
            inputTokens: residualInput,
            outputTokens: residualOutput,
            failureKind: "batch_partial_error",
          }];
    const occurredAt = now().toISOString();
    let classified = 0;
    const transaction = dependencies.database.transaction(() => {
      const duplicateAttempts: ClassificationAttemptEvidence[] = [];
      for (const completed of successful) {
        const exists = dependencies.database.prepare(`
          SELECT 1 FROM classifications WHERE product_id = ? AND version = ?
        `).get(completed.input.productId, current.version) !== undefined;
        if (exists) {
          duplicateAttempts.push({
            provider: completed.result.provider,
            requestedModel: current.requested_model,
            actualModel: completed.result.model,
            responseId: null,
            attempt: 1,
            inputTokens: completed.result.usage.inputTokens,
            outputTokens: completed.result.usage.outputTokens,
            failureKind: "duplicate_conflict",
          });
          continue;
        }
        const cost = budgetGuard.estimateModelCost({
          model: completed.result.model,
          inputTokens: completed.result.usage.inputTokens,
          outputTokens: completed.result.usage.outputTokens,
        });
        persistClassificationBatch(
          dependencies.database,
          [completed.input],
          new Map([[completed.product.id, completed.product]]),
          completed.result,
          current.confidence_threshold,
          current.version,
          occurredAt,
          cost,
        );
        classified += 1;
      }
      persistFailureAttempts(
        dependencies.database,
        [...failureAttempts, ...duplicateAttempts],
        budgetGuard,
        {
          occurredAt,
          productIds: itemRows.map((item) => item.product_id),
          version: current.version,
          batchJobId: current.id,
        },
      );
      const failed = current.total_items - classified;
      const status = failed === 0
        ? "finalized"
        : classified > 0
          ? "finalized_partial"
          : "finalized_failed";
      dependencies.database.prepare(`
        UPDATE classification_batch_jobs
        SET status = ?, completed_items = ?, failed_items = ?, finalized_at = ?,
            updated_at = ?, error_message = NULL
        WHERE id = ?
      `).run(status, classified, failed, occurredAt, occurredAt, current.id);
      insertEvent(dependencies.database, {
        jobId: current.id,
        status,
        provider: { classified, failed },
        occurredAt,
      });
    });
    transaction.immediate();
    current = job(dependencies.database, jobId);
    return finalizedSummary(dependencies.database, current);
  } catch (error) {
    current = job(dependencies.database, jobId);
    if (isTransientOpenAIError(error)) {
      recordFinalizeRetryable(dependencies.database, current, now(), error);
    } else {
      recordFinalizeFailure(dependencies.database, current, budgetGuard, now(), error);
    }
    throw error;
  }
}
