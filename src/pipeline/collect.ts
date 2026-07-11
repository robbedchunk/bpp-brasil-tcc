import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import { executeExtraction } from "../collection/executor.js";
import {
  NetworkRequestBoundaryError,
  type ExtractionExecutionContext,
} from "../collection/http.js";
import {
  reservoirSample,
  writeReplayPayload,
  type ReplayPayload,
} from "../collection/replay.js";
import {
  admitReplaySlot,
  admitRequest,
  createRun,
  DAILY_REPLAY_ADMISSION_BUDGET,
  finalizeRun,
  findActiveExtractionStrategy,
  insertObservation,
  insertRunFailure,
  listCollectionProducts,
  remainingRequestAdmissions,
  remainingReplaySlotAdmissions,
  REQUEST_BUDGET_BY_STAGE,
  type ReplayReference,
  type StoredProductRef,
} from "../db/repositories.js";
import { JsonlLogger } from "../ops/logger.js";
import type { ExtractionStrategy } from "../strategies/schema.js";
import type {
  ExtractionResult,
  FailureCategory,
} from "../strategies/types.js";
import { mapConcurrent, productionConcurrency } from "./concurrency.js";
import { collectionDay, terminalStatus, type RunSummary } from "./discover.js";

export interface CollectionPipelineDependencies {
  database: Database.Database;
  execute?: (
    strategy: ExtractionStrategy,
    ref: StoredProductRef,
    context?: ExtractionExecutionContext,
  ) => Promise<ExtractionResult>;
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
  now?: () => Date;
  id?: () => string;
  random?: () => number;
  rawHtmlRoot?: string;
  logDirectory?: string;
  politeDelayMs?: { min: number; max: number };
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  concurrentMap?: typeof mapConcurrent;
  blockingPolicy?: BlockingBackoffPolicy;
}

export interface BlockingBackoffPolicy {
  hardFailureLimit: number;
  transportFailureLimit: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface CollectionRunSummary extends RunSummary {
  planned: number;
  skipped: number;
  stoppedForBlocking: boolean;
}

const MAX_DAILY_PAGES = REQUEST_BUDGET_BY_STAGE.collect;
const DEFAULT_BLOCKING_POLICY: BlockingBackoffPolicy = {
  hardFailureLimit: 3,
  transportFailureLimit: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};
const HARD_BLOCKING_FAILURES = new Set<FailureCategory>([
  "http-403",
  "http-429",
  "captcha",
  "domain-denied",
]);
const TRANSPORT_FAILURES = new Set<FailureCategory>(["timeout", "network"]);

interface PendingHtmlAttempt {
  product: StoredProductRef;
  result: ExtractionResult;
}

function rejected(error: unknown): ExtractionResult {
  return {
    ok: false,
    failure: {
      category: "unknown",
      message: error instanceof Error ? error.message : String(error) || "Executor rejected",
      responded: false,
    },
  };
}

function createPoliteGate(
  delay: CollectionPipelineDependencies["politeDelayMs"],
  random: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  clock: () => number,
): () => Promise<void> {
  if (delay === undefined) return async () => {};
  const minimum = Math.max(0, Math.trunc(delay.min));
  const maximum = Math.max(minimum, Math.trunc(delay.max));
  let first = true;
  let nextStart = clock();
  let queue = Promise.resolve();

  return async () => {
    const turn = queue.then(async () => {
      if (first) {
        first = false;
        nextStart = clock();
        return;
      }
      const spacing = minimum + Math.floor(random() * (maximum - minimum + 1));
      const current = clock();
      nextStart = Math.max(nextStart, current) + spacing;
      const wait = Math.max(0, nextStart - current);
      if (wait > 0) await sleep(wait);
    });
    queue = turn.catch(() => {});
    await turn;
  };
}

interface BlockingController {
  beforeAttempt(): Promise<boolean>;
  completeAttempt(result: ExtractionResult): void;
  cancelAttempt(): void;
  readonly stopped: boolean;
  readonly stopCategory: FailureCategory | null;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function createBlockingController(
  configured: BlockingBackoffPolicy | undefined,
  sleep: (milliseconds: number) => Promise<void>,
  clock: () => number,
  politeGate: () => Promise<void>,
): BlockingController {
  const source = configured ?? DEFAULT_BLOCKING_POLICY;
  const policy = {
    hardFailureLimit: positiveInteger(
      source.hardFailureLimit,
      DEFAULT_BLOCKING_POLICY.hardFailureLimit,
    ),
    transportFailureLimit: positiveInteger(
      source.transportFailureLimit,
      DEFAULT_BLOCKING_POLICY.transportFailureLimit,
    ),
    initialDelayMs: nonNegativeInteger(
      source.initialDelayMs,
      DEFAULT_BLOCKING_POLICY.initialDelayMs,
    ),
    maxDelayMs: nonNegativeInteger(
      source.maxDelayMs,
      DEFAULT_BLOCKING_POLICY.maxDelayMs,
    ),
  };
  policy.maxDelayMs = Math.max(policy.initialDelayMs, policy.maxDelayMs);

  let hardFailures = 0;
  let transportFailures = 0;
  let blockingAttempts = 0;
  let notBefore = clock();
  let inFlight = 0;
  let provisionalStop = false;
  let stopped = false;
  let stopCategory: FailureCategory | null = null;
  let queue = Promise.resolve();
  const stateWaiters = new Set<() => void>();

  const notifyStateChange = (): void => {
    const waiters = [...stateWaiters];
    stateWaiters.clear();
    waiters.forEach((resolveWaiter) => resolveWaiter());
  };
  const waitForStateChange = (): Promise<void> =>
    new Promise((resolveWaiter) => stateWaiters.add(resolveWaiter));

  return {
    async beforeAttempt(): Promise<boolean> {
      const turn = queue.then(async () => {
        let politeReady = false;
        while (true) {
          if (stopped) return false;
          if (provisionalStop) {
            if (inFlight === 0) {
              stopped = true;
              return false;
            }
            await waitForStateChange();
            continue;
          }
          if (!politeReady) {
            await politeGate();
            politeReady = true;
            continue;
          }
          const delay = Math.max(0, notBefore - clock());
          if (delay > 0) {
            await sleep(delay);
            continue;
          }
          if (stopped || provisionalStop) continue;
          inFlight += 1;
          return true;
        }
      });
      queue = turn.then(() => undefined, () => undefined);
      return turn;
    },
    completeAttempt(result: ExtractionResult): void {
      if (inFlight <= 0) throw new Error("Blocking controller completed an unstarted attempt");
      const category = result.ok === false ? result.failure?.category : undefined;
      if (category !== undefined && HARD_BLOCKING_FAILURES.has(category)) {
        hardFailures += 1;
        blockingAttempts += 1;
      } else if (category !== undefined && TRANSPORT_FAILURES.has(category)) {
        transportFailures += 1;
        blockingAttempts += 1;
      } else {
        hardFailures = 0;
        transportFailures = 0;
        blockingAttempts = 0;
        notBefore = clock();
        provisionalStop = false;
        stopCategory = null;
      }

      if (category !== undefined && (
        HARD_BLOCKING_FAILURES.has(category) || TRANSPORT_FAILURES.has(category)
      )) {
        const qualifiedTransport = transportFailures >= 2 ? transportFailures : 0;
        const unifiedAccessStreak = hardFailures + qualifiedTransport;
        const reachedStop = transportFailures >= Math.max(2, policy.transportFailureLimit)
          || (hardFailures > 0 && unifiedAccessStreak >= policy.hardFailureLimit);
        if (reachedStop) {
          if (!provisionalStop) stopCategory = category;
          provisionalStop = true;
        } else {
          const exponential = policy.initialDelayMs
            * (2 ** Math.max(0, blockingAttempts - 1));
          const bounded = Math.min(policy.maxDelayMs, exponential);
          notBefore = Math.max(notBefore, clock()) + bounded;
        }
      }

      inFlight -= 1;
      if (provisionalStop && inFlight === 0) stopped = true;
      notifyStateChange();
    },
    cancelAttempt(): void {
      if (inFlight <= 0) {
        throw new Error("Blocking controller cancelled an unstarted attempt");
      }
      inFlight -= 1;
      if (provisionalStop && inFlight === 0) stopped = true;
      notifyStateChange();
    },
    get stopped(): boolean {
      return stopped;
    },
    get stopCategory(): FailureCategory | null {
      return stopCategory;
    },
  };
}

export async function runCollection(
  retailerId: string,
  dependencies: CollectionPipelineDependencies,
): Promise<CollectionRunSummary> {
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.id ?? randomUUID;
  const startedAt = now().toISOString();
  const day = collectionDay(new Date(startedAt));
  const active = findActiveExtractionStrategy(dependencies.database, retailerId);
  const remainingDaily = remainingRequestAdmissions(
    dependencies.database,
    retailerId,
    day,
    "collect",
  );
  const limit = Math.min(
    remainingDaily,
    Math.max(0, Math.trunc(dependencies.limit ?? MAX_DAILY_PAGES)),
  );
  const products = listCollectionProducts(dependencies.database, retailerId, limit);
  const runId = dependencies.dryRun === true ? `dry-run-${makeId()}` : makeId();
  if (dependencies.dryRun === true) {
    return {
      id: runId,
      retailerId,
      stage: "collect",
      attempted: 0,
      ok: 0,
      failed: 0,
      planned: products.length,
      skipped: 0,
      stoppedForBlocking: false,
      successRate: 0,
      status: "completed",
      startedAt,
      finishedAt: now().toISOString(),
      dryRun: true,
    };
  }
  const counters = { attempted: 0, ok: 0, failed: 0 };

  createRun(dependencies.database, {
    id: runId,
    retailerId,
    stage: "collect",
    collectionDay: day,
    strategyId: active.id,
    strategyVersion: active.version,
    startedAt,
  });
  const logger = dependencies.logDirectory === undefined
    ? null
    : new JsonlLogger({
        directory: dependencies.logDirectory,
        basename: `collect-${runId}`,
        now,
      });
  const loggingErrors: string[] = [];
  const log = async (
    level: "info" | "warning" | "error",
    event: string,
    fields: unknown,
  ): Promise<void> => {
    if (logger === null) return;
    try {
      await logger.log(level, event, fields);
    } catch (error) {
      loggingErrors.push(error instanceof Error ? error.message : "Run logging failed");
    }
  };
  await log("info", "run.started", {
    runId,
    retailerId,
    stage: "collect",
    strategyId: active.id,
    strategyVersion: active.version,
    planned: products.length,
    dailyRemainingBeforeRun: remainingDaily,
  });

  let finishedAt = startedAt;
  let status = terminalStatus(0, 0);
  let finalError: { category: FailureCategory; message: string } | undefined;
  let pipelineFailed = false;
  let stopped = false;
  try {
    if (loggingErrors.length > 0) {
      throw new Error(loggingErrors[0] ?? "Collection run logging initialization failed");
    }
    const execute = dependencies.execute ?? executeExtraction;
    const random = dependencies.random ?? Math.random;
    const replayRoot = resolve(dependencies.rawHtmlRoot ?? "data/raw-html");
    const persistenceErrors: string[] = [];
    const replayCapacity = remainingReplaySlotAdmissions(
      dependencies.database,
      retailerId,
      day,
    );
    const replayProductIds = new Set(
      (replayCapacity === 0
        ? []
        : reservoirSample(
            products,
            Math.min(replayCapacity, DAILY_REPLAY_ADMISSION_BUDGET),
            random,
          ))
        .map(({ id }) => id),
    );
    const sleep = dependencies.sleep ?? ((milliseconds: number) =>
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    const clock = dependencies.clock ?? Date.now;
    const politeGate = createPoliteGate(
      dependencies.politeDelayMs,
      random,
      sleep,
      clock,
    );
    const transportManagedAdmissions = dependencies.execute === undefined;
    const blockingController = createBlockingController(
      dependencies.blockingPolicy,
      sleep,
      clock,
      transportManagedAdmissions ? async () => {} : politeGate,
    );
    let requestBudgetExhausted = false;

    const persistAttempt = async (
      pending: PendingHtmlAttempt,
      replay?: ReplayReference,
    ): Promise<ExtractionResult> => {
      let { result } = pending;

      if (result.ok === true && result.fields !== undefined) {
        try {
          insertObservation(dependencies.database, {
            product: pending.product,
            runId,
            result,
            observedAt: now().toISOString(),
            collectionDay: day,
            strategyId: active.id,
            strategyVersion: active.version,
            ...(replay === undefined ? {} : { replay }),
          });
          counters.ok += 1;
          return result;
        } catch (error) {
          result = rejected(error);
        }
      } else if (result.failure === undefined) {
        result = {
          ok: false,
          failure: {
            category: "unknown",
            message: "Extraction returned neither fields nor failure",
            responded: false,
          },
        };
      }

      counters.failed += 1;
      try {
        insertRunFailure(dependencies.database, {
          runId,
          retailerId,
          product: pending.product,
          failure: result.failure ?? {
            category: "unknown",
            message: "Extraction returned neither fields nor failure",
            responded: false,
          },
          occurredAt: now().toISOString(),
          strategyId: active.id,
          strategyVersion: active.version,
          ...(replay === undefined ? {} : { replay }),
        });
      } catch (error) {
        persistenceErrors.push(
          error instanceof Error ? error.message : "Failure evidence persistence failed",
        );
      }
      return result;
    };

    await (dependencies.concurrentMap ?? mapConcurrent)(
      products,
      productionConcurrency(dependencies.concurrency),
      async (product): Promise<void> => {
        if (requestBudgetExhausted) return;
        if (!await blockingController.beforeAttempt()) return;
        if (!transportManagedAdmissions) {
          let admitted = false;
          try {
            admitted = admitRequest(dependencies.database, {
              runId,
              retailerId,
              collectionDay: day,
              stage: "collect",
              admittedAt: now().toISOString(),
            }).admitted;
          } catch (error) {
            blockingController.cancelAttempt();
            throw error;
          }
          if (!admitted) {
            requestBudgetExhausted = true;
            blockingController.cancelAttempt();
            return;
          }
        }
        counters.attempted += 1;
        let result: ExtractionResult;
        try {
          result = await execute(active.strategy, product, transportManagedAdmissions
            ? {
                beforeNetworkRequest: async () => {
                  await politeGate();
                  const admission = admitRequest(dependencies.database, {
                    runId,
                    retailerId,
                    collectionDay: day,
                    stage: "collect",
                    admittedAt: now().toISOString(),
                  });
                  if (!admission.admitted) {
                    requestBudgetExhausted = true;
                    throw new NetworkRequestBoundaryError({
                      category: "network",
                      message: "Daily retailer network request budget is exhausted",
                      responded: false,
                    });
                  }
                },
              }
            : undefined);
        } catch (error) {
          result = rejected(error);
        }
        const pending = { product, result };
        const payload: ReplayPayload | undefined = result.replay
          ?? (result.html === undefined
            ? undefined
            : { body: result.html, mediaType: "text/html" });
        let replay: ReplayReference | undefined;
        if (payload !== undefined && replayProductIds.has(product.id)) {
          try {
            const replayAdmitted = admitReplaySlot(dependencies.database, {
              runId,
              retailerId,
              productId: product.id,
              collectionDay: day,
              admittedAt: now().toISOString(),
            }).admitted;
            if (replayAdmitted) {
              const artifact = await writeReplayPayload(
                payload,
                replayRoot,
                day,
                retailerId,
              );
              replay = { path: artifact.path, sha256: artifact.sha256 };
            }
          } catch (error) {
            persistenceErrors.push(
              error instanceof Error ? error.message : "Replay sampling failed",
            );
          }
        }
        let effectiveResult = result;
        try {
          effectiveResult = await persistAttempt(pending, replay);
          await log(effectiveResult.ok ? "info" : "warning", "attempt.finished", {
            runId,
            retailerId,
            productId: product.id,
            ok: effectiveResult.ok,
            category: effectiveResult.failure?.category ?? null,
            replayed: replay !== undefined,
          });
        } finally {
          blockingController.completeAttempt(effectiveResult);
        }
      },
    );
    if (blockingController.stopped) {
      stopped = true;
      finalError = {
        category: blockingController.stopCategory ?? "unknown",
        message: `Collection stopped after persistent blocking; ${counters.attempted} of ${products.length} planned products were attempted`,
      };
    }
    if (persistenceErrors.length > 0) {
      pipelineFailed = true;
      finalError = { category: "unknown", message: persistenceErrors[0] ?? "Persistence failed" };
    }
  } catch (error) {
    pipelineFailed = true;
    const failure = rejected(error).failure ?? {
      category: "unknown" as const,
      message: "Collection pipeline failed",
      responded: false,
    };
    finalError = { category: "unknown", message: failure.message };
    const unaccounted = counters.attempted - counters.ok - counters.failed;
    counters.failed += Math.max(0, unaccounted);
    try {
      insertRunFailure(dependencies.database, {
        runId,
        retailerId,
        failure,
        occurredAt: now().toISOString(),
        strategyId: active.id,
        strategyVersion: active.version,
      });
    } catch {
      // Finalizing the runs-first lifecycle remains the priority if evidence I/O failed.
    }
  } finally {
    finishedAt = now().toISOString();
    status = pipelineFailed
      ? counters.ok > 0 ? "partial" : "failed"
      : terminalStatus(counters.ok, counters.failed);
    const skipped = Math.max(0, products.length - counters.attempted);
    if (loggingErrors.length > 0) {
      pipelineFailed = true;
      finalError ??= {
        category: "unknown",
        message: loggingErrors[0] ?? "Run logging failed",
      };
      status = counters.ok > 0 ? "partial" : "failed";
    }
    await log(status === "completed" ? "info" : "warning", "run.finished", {
      runId,
      retailerId,
      stage: "collect",
      status,
      ...counters,
      planned: products.length,
      skipped,
      stoppedForBlocking: stopped,
    });
    if (loggingErrors.length > 0) {
      pipelineFailed = true;
      finalError ??= {
        category: "unknown",
        message: loggingErrors[0] ?? "Run logging failed",
      };
      status = counters.ok > 0 ? "partial" : "failed";
    }
    finalizeRun(
      dependencies.database,
      runId,
      counters,
      status,
      finishedAt,
      finalError,
      {
        planned: products.length,
        skipped,
        stoppedForBlocking: stopped,
      },
    );
  }
  return {
    id: runId,
    retailerId,
    stage: "collect",
    ...counters,
    planned: products.length,
    skipped: Math.max(0, products.length - counters.attempted),
    stoppedForBlocking: stopped,
    successRate: counters.attempted === 0 ? 0 : counters.ok / counters.attempted,
    status,
    startedAt,
    finishedAt,
    dryRun: false,
  };
}
