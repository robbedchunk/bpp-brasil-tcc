import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import { executeExtraction } from "../collection/executor.js";
import {
  writeReplayHtml,
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
import type { ExtractionResult } from "../strategies/types.js";
import { mapConcurrent } from "./concurrency.js";
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
}

const MAX_DAILY_PAGES = 2_000;
const DAILY_REPLAY_SAMPLE = 20;

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

export async function runCollection(
  retailerId: string,
  dependencies: CollectionPipelineDependencies,
): Promise<RunSummary> {
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.id ?? randomUUID;
  const startedAt = now().toISOString();
  const day = collectionDay(new Date(startedAt));
  const active = findActiveExtractionStrategy(dependencies.database, retailerId);
  const remainingDaily = Math.max(
    0,
    MAX_DAILY_PAGES - attemptedForDay(dependencies.database, retailerId, "collect", day),
  );
  const limit = Math.min(
    remainingDaily,
    Math.max(0, Math.trunc(dependencies.limit ?? MAX_DAILY_PAGES)),
  );
  const products = listCollectionProducts(dependencies.database, retailerId, limit);
  const runId = dependencies.dryRun === true ? `dry-run-${makeId()}` : makeId();
  const counters = { attempted: products.length, ok: 0, failed: 0 };

  if (dependencies.dryRun !== true) {
    createRun(dependencies.database, {
      id: runId,
      retailerId,
      stage: "collect",
      collectionDay: day,
      strategyId: active.id,
      strategyVersion: active.version,
      startedAt,
    });
  }

  let finishedAt = startedAt;
  let status = terminalStatus(0, 0);
  let finalError: { category: "unknown"; message: string } | undefined;
  try {
    const execute = dependencies.execute ?? executeExtraction;
    const random = dependencies.random ?? Math.random;
    const replayRoot = resolve(dependencies.rawHtmlRoot ?? "data/raw-html");
    const persistenceErrors: string[] = [];
    const htmlReservoir: PendingHtmlAttempt[] = [];
    let eligibleHtmlSeen = 0;
    const politeGate = createPoliteGate(
      dependencies.politeDelayMs,
      random,
      dependencies.sleep ?? ((milliseconds) =>
        new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
      dependencies.clock ?? Date.now,
    );

    const persistAttempt = async (
      pending: PendingHtmlAttempt,
      withReplay: boolean,
    ): Promise<void> => {
      let { result } = pending;
      let replayArtifact;
      if (
        dependencies.dryRun !== true
        && withReplay
        && result.html !== undefined
      ) {
        try {
          replayArtifact = await writeReplayHtml(
            result.html,
            replayRoot,
            day,
            retailerId,
          );
        } catch (error) {
          result = rejected(error);
        }
      }

      if (result.ok === true && result.fields !== undefined) {
        if (dependencies.dryRun === true) {
          counters.ok += 1;
          return;
        }
        try {
          insertObservation(dependencies.database, {
            product: pending.product,
            runId,
            result,
            observedAt: now().toISOString(),
            collectionDay: day,
            strategyId: active.id,
            strategyVersion: active.version,
            ...(replayArtifact === undefined ? {} : { replay: replayArtifact }),
          });
          counters.ok += 1;
          return;
        } catch (error) {
          result = rejected(error);
        }
      }

      counters.failed += 1;
      if (dependencies.dryRun === true) return;
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
          ...(replayArtifact === undefined ? {} : { replay: replayArtifact }),
        });
      } catch (error) {
        persistenceErrors.push(
          error instanceof Error ? error.message : "Failure evidence persistence failed",
        );
      }
    };

    await mapConcurrent(
      products,
      dependencies.concurrency,
      async (product): Promise<void> => {
        let result: ExtractionResult;
        try {
          await politeGate();
          result = await execute(active.strategy, product);
        } catch (error) {
          result = rejected(error);
        }
        const pending = { product, result };
        if (dependencies.dryRun === true || result.html === undefined) {
          await persistAttempt(pending, false);
          return;
        }
        eligibleHtmlSeen += 1;
        if (htmlReservoir.length < DAILY_REPLAY_SAMPLE) {
          htmlReservoir.push(pending);
          return;
        }
        const replacement = Math.floor(random() * eligibleHtmlSeen);
        if (replacement < DAILY_REPLAY_SAMPLE) {
          const evicted = htmlReservoir[replacement];
          htmlReservoir[replacement] = pending;
          if (evicted !== undefined) await persistAttempt(evicted, false);
          return;
        }
        await persistAttempt(pending, false);
      },
    );
    for (const pending of htmlReservoir) {
      await persistAttempt(pending, true);
    }
    if (persistenceErrors.length > 0) {
      finalError = { category: "unknown", message: persistenceErrors[0] ?? "Persistence failed" };
    }
  } catch (error) {
    const failure = rejected(error).failure ?? {
      category: "unknown" as const,
      message: "Collection pipeline failed",
      responded: false,
    };
    finalError = { category: "unknown", message: failure.message };
    const unaccounted = counters.attempted - counters.ok - counters.failed;
    counters.failed += Math.max(0, unaccounted);
    if (counters.attempted === 0) {
      counters.attempted = 1;
      counters.failed = 1;
    }
    if (dependencies.dryRun !== true) {
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
    }
  } finally {
    finishedAt = now().toISOString();
    status = terminalStatus(counters.ok, counters.failed);
    if (dependencies.dryRun !== true) {
      finalizeRun(
        dependencies.database,
        runId,
        counters,
        status,
        finishedAt,
        finalError,
      );
    }
  }
  return {
    id: runId,
    retailerId,
    stage: "collect",
    ...counters,
    successRate: counters.attempted === 0 ? 0 : counters.ok / counters.attempted,
    status,
    startedAt,
    finishedAt,
    dryRun: dependencies.dryRun === true,
  };
}
