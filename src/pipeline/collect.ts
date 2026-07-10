import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import { executeExtraction } from "../collection/executor.js";
import {
  reservoirSample,
  writeReplayHtml,
  type ReplayArtifact,
} from "../collection/replay.js";
import {
  createRun,
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
}

interface AttemptResult {
  product: StoredProductRef;
  result: ExtractionResult;
}

const MAX_DAILY_PAGES = 2_000;
const DAILY_REPLAY_SAMPLE = 20;

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

export async function runCollection(
  retailerId: string,
  dependencies: CollectionPipelineDependencies,
): Promise<RunSummary> {
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.id ?? randomUUID;
  const startedAt = now().toISOString();
  const day = collectionDay(new Date(startedAt));
  const active = findActiveExtractionStrategy(dependencies.database, retailerId);
  const limit = Math.min(
    MAX_DAILY_PAGES,
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

  const execute = dependencies.execute ?? executeExtraction;
  const attempts = await mapConcurrent(
    products,
    dependencies.concurrency,
    async (product): Promise<AttemptResult> => {
      try {
        return { product, result: await execute(active.strategy, product) };
      } catch (error) {
        return { product, result: rejected(error) };
      }
    },
  );

  const eligible = attempts
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => typeof attempt.result.html === "string");
  const selected = new Set(
    reservoirSample(
      eligible,
      Math.min(DAILY_REPLAY_SAMPLE, eligible.length),
      dependencies.random,
    ).map(({ index }) => index),
  );
  const replay = new Map<number, ReplayArtifact>();
  if (dependencies.dryRun !== true) {
    const root = resolve(dependencies.rawHtmlRoot ?? "data/raw-html");
    await Promise.all([...selected].map(async (index) => {
      const html = attempts[index]?.result.html;
      if (html !== undefined) {
        replay.set(index, await writeReplayHtml(html, root, day, retailerId));
      }
    }));
  }

  for (const [index, attempt] of attempts.entries()) {
    const replayArtifact = replay.get(index);
    if (attempt.result.ok === true && attempt.result.fields !== undefined) {
      counters.ok += 1;
      if (dependencies.dryRun !== true) {
        insertObservation(dependencies.database, {
          product: attempt.product,
          runId,
          result: attempt.result,
          observedAt: now().toISOString(),
          collectionDay: day,
          strategyId: active.id,
          strategyVersion: active.version,
          ...(replayArtifact === undefined ? {} : { replay: replayArtifact }),
        });
      }
    } else {
      counters.failed += 1;
      if (dependencies.dryRun !== true) {
        insertRunFailure(dependencies.database, {
          runId,
          retailerId,
          product: attempt.product,
          failure: attempt.result.failure ?? {
            category: "unknown",
            message: "Extraction returned neither fields nor failure",
            responded: false,
          },
          occurredAt: now().toISOString(),
          strategyId: active.id,
          strategyVersion: active.version,
          ...(replayArtifact === undefined ? {} : { replay: replayArtifact }),
        });
      }
    }
  }

  const finishedAt = now().toISOString();
  const status = terminalStatus(counters.ok, counters.failed);
  if (dependencies.dryRun !== true) {
    finalizeRun(dependencies.database, runId, counters, status, finishedAt);
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
