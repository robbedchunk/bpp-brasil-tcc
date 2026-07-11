import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import { executeExtraction } from "../collection/executor.js";
import {
  openDailyReplayReservoir,
  type ReplayEvidenceRef,
} from "../collection/replay.js";
import {
  createRun,
  attemptedForDay,
  finalizeRun,
  findActiveExtractionStrategy,
  insertObservation,
  insertRunFailure,
  listCollectionProducts,
  type StoredProductRef,
} from "../db/repositories.js";
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
  ) => Promise<ExtractionResult>;
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
  now?: () => Date;
  id?: () => string;
  random?: () => number;
  rawHtmlRoot?: string;
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

const MAX_DAILY_PAGES = 2_000;
const DAILY_REPLAY_SAMPLE = 20;
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
  observe(result: ExtractionResult): void;
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

  let consecutiveHard = 0;
  let consecutiveTransport = 0;
  let notBefore = clock();
  let stopped = false;
  let stopCategory: FailureCategory | null = null;
  let queue = Promise.resolve();

  return {
    async beforeAttempt(): Promise<boolean> {
      const turn = queue.then(async () => {
        if (stopped) return false;
        const delay = Math.max(0, notBefore - clock());
        if (delay > 0) await sleep(delay);
        return !stopped;
      });
      queue = turn.then(() => undefined, () => undefined);
      return turn;
    },
    observe(result: ExtractionResult): void {
      const category = result.ok === false ? result.failure?.category : undefined;
      let sequence = 0;
      let limit = 0;
      if (category !== undefined && HARD_BLOCKING_FAILURES.has(category)) {
        consecutiveHard += 1;
        consecutiveTransport = 0;
        sequence = consecutiveHard;
        limit = policy.hardFailureLimit;
      } else if (category !== undefined && TRANSPORT_FAILURES.has(category)) {
        consecutiveTransport += 1;
        consecutiveHard = 0;
        sequence = consecutiveTransport;
        limit = policy.transportFailureLimit;
      } else {
        consecutiveHard = 0;
        consecutiveTransport = 0;
        notBefore = clock();
        return;
      }

      if (sequence >= limit) {
        stopped = true;
        stopCategory = category ?? null;
        return;
      }
      const exponential = policy.initialDelayMs * (2 ** Math.max(0, sequence - 1));
      const bounded = Math.min(policy.maxDelayMs, exponential);
      notBefore = Math.max(notBefore, clock()) + bounded;
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
  const remainingDaily = Math.max(
    0,
    MAX_DAILY_PAGES - attemptedForDay(dependencies.database, retailerId, day),
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

  let finishedAt = startedAt;
  let status = terminalStatus(0, 0);
  let finalError: { category: FailureCategory; message: string } | undefined;
  let pipelineFailed = false;
  let stopped = false;
  try {
    const execute = dependencies.execute ?? executeExtraction;
    const random = dependencies.random ?? Math.random;
    const replayRoot = resolve(dependencies.rawHtmlRoot ?? "data/raw-html");
    const persistenceErrors: string[] = [];
    const replayReservoir = await openDailyReplayReservoir(
      replayRoot,
      day,
      retailerId,
      { size: DAILY_REPLAY_SAMPLE, random },
    );
    const politeGate = createPoliteGate(
      dependencies.politeDelayMs,
      random,
      dependencies.sleep ?? ((milliseconds) =>
        new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
      dependencies.clock ?? Date.now,
    );
    const blockingController = createBlockingController(
      dependencies.blockingPolicy,
      dependencies.sleep ?? ((milliseconds) =>
        new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
      dependencies.clock ?? Date.now,
    );

    const persistAttempt = async (
      pending: PendingHtmlAttempt,
    ): Promise<ReplayEvidenceRef | undefined> => {
      let { result } = pending;

      if (result.ok === true && result.fields !== undefined) {
        try {
          const id = insertObservation(dependencies.database, {
            product: pending.product,
            runId,
            result,
            observedAt: now().toISOString(),
            collectionDay: day,
            strategyId: active.id,
            strategyVersion: active.version,
          });
          counters.ok += 1;
          return { kind: "observation", id };
        } catch (error) {
          result = rejected(error);
        }
      }

      counters.failed += 1;
      try {
        const id = insertRunFailure(dependencies.database, {
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
        });
        return { kind: "failure", id };
      } catch (error) {
        persistenceErrors.push(
          error instanceof Error ? error.message : "Failure evidence persistence failed",
        );
        return undefined;
      }
    };

    await (dependencies.concurrentMap ?? mapConcurrent)(
      products,
      productionConcurrency(dependencies.concurrency),
      async (product): Promise<void> => {
        if (!await blockingController.beforeAttempt()) return;
        counters.attempted += 1;
        let result: ExtractionResult;
        try {
          await politeGate();
          result = await execute(active.strategy, product);
        } catch (error) {
          result = rejected(error);
        }
        const pending = { product, result };
        const html = result.html;
        const evidence = await persistAttempt(pending);
        blockingController.observe(result);
        if (html === undefined || evidence === undefined) return;
        try {
          await replayReservoir.consider(html, evidence);
        } catch (error) {
          persistenceErrors.push(
            error instanceof Error ? error.message : "Replay sampling failed",
          );
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
    finalizeRun(
      dependencies.database,
      runId,
      counters,
      status,
      finishedAt,
      finalError,
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
