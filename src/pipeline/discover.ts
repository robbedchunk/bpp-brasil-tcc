import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  createRun,
  attemptedForDay,
  finalizeRun,
  findActiveDiscoveryStrategy,
  insertRunFailure,
  upsertDiscoveredProduct,
} from "../db/repositories.js";
import { executeDiscovery } from "../discovery/executor.js";
import type { DiscoveryStrategy } from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";

export type RunStatus = "completed" | "partial" | "failed";

export interface RunSummary {
  id: string;
  retailerId: string;
  stage: "discover" | "collect";
  attempted: number;
  ok: number;
  failed: number;
  successRate: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
}

export interface DiscoveryPipelineDependencies {
  database: Database.Database;
  execute?: (strategy: DiscoveryStrategy) => AsyncIterable<ProductRef>;
  limit?: number;
  dryRun?: boolean;
  now?: () => Date;
  id?: () => string;
}

const MAX_DAILY_PAGES = 2_000;

export function collectionDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function terminalStatus(ok: number, failed: number): RunStatus {
  if (failed === 0) return "completed";
  return ok > 0 ? "partial" : "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : String(error) || "Unknown pipeline error";
}

export async function runDiscovery(
  retailerId: string,
  dependencies: DiscoveryPipelineDependencies,
): Promise<RunSummary> {
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.id ?? randomUUID;
  const startedAt = now().toISOString();
  const day = collectionDay(new Date(startedAt));
  const active = findActiveDiscoveryStrategy(dependencies.database, retailerId);
  const runId = dependencies.dryRun === true ? `dry-run-${makeId()}` : makeId();
  const limit = Math.min(
    Math.max(
      0,
      MAX_DAILY_PAGES - attemptedForDay(
        dependencies.database,
        retailerId,
        "discover",
        day,
      ),
    ),
    Math.max(0, Math.trunc(dependencies.limit ?? MAX_DAILY_PAGES)),
  );
  const counters = { attempted: 0, ok: 0, failed: 0 };
  let finalError: { category: "unknown"; message: string } | undefined;
  let finishedAt = startedAt;
  let status = terminalStatus(0, 0);

  if (dependencies.dryRun !== true) {
    createRun(dependencies.database, {
      id: runId,
      retailerId,
      stage: "discover",
      collectionDay: day,
      strategyId: active.id,
      strategyVersion: active.version,
      startedAt,
    });
  }

  try {
    try {
      const refs = (dependencies.execute ?? ((strategy) => executeDiscovery(strategy)))(active.strategy);
      const iterator = refs[Symbol.asyncIterator]();
      while (counters.attempted < limit) {
        const next = await iterator.next();
        if (next.done) break;
        const ref = next.value;
        counters.attempted += 1;
        if (dependencies.dryRun === true) {
          counters.ok += 1;
          continue;
        }
        try {
          upsertDiscoveredProduct(dependencies.database, retailerId, ref, now().toISOString());
          counters.ok += 1;
        } catch (error) {
          counters.failed += 1;
          try {
            insertRunFailure(dependencies.database, {
              runId,
              retailerId,
              canonicalUrl: ref.canonicalUrl,
              failure: {
                category: "unknown",
                message: errorMessage(error),
                responded: false,
              },
              occurredAt: now().toISOString(),
              strategyId: active.id,
              strategyVersion: active.version,
            });
          } catch (persistenceError) {
            finalError = {
              category: "unknown",
              message: errorMessage(persistenceError),
            };
          }
        }
      }
      if (counters.attempted >= limit) {
        try {
          await iterator.return?.();
        } catch {
          // Iterator cleanup is not another page attempt and cannot exceed the cap.
        }
      }
    } catch (error) {
      counters.attempted += 1;
      counters.failed += 1;
      finalError = { category: "unknown", message: errorMessage(error) };
      if (dependencies.dryRun !== true) {
        try {
          insertRunFailure(dependencies.database, {
            runId,
            retailerId,
            failure: { ...finalError, responded: false },
            occurredAt: now().toISOString(),
            strategyId: active.id,
            strategyVersion: active.version,
          });
        } catch (persistenceError) {
          finalError = {
            category: "unknown",
            message: errorMessage(persistenceError),
          };
        }
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
    stage: "discover",
    ...counters,
    successRate: counters.attempted === 0 ? 0 : counters.ok / counters.attempted,
    status,
    startedAt,
    finishedAt,
    dryRun: dependencies.dryRun === true,
  };
}
