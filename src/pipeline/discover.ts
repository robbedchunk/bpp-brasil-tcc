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
import type { DiscoveryExecutionContext } from "../discovery/executor.js";
import {
  DiscoveryFailureError,
  discoveryFailureFromUnknown,
} from "../discovery/failure.js";
import { RobotsPolicy } from "../discovery/robots.js";
import { fetchBounded } from "../collection/http.js";
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
  planned?: number;
}

export interface DiscoveryPipelineDependencies {
  database: Database.Database;
  execute?: (
    strategy: DiscoveryStrategy,
    context: DiscoveryExecutionContext,
  ) => AsyncIterable<ProductRef>;
  limit?: number;
  dryRun?: boolean;
  now?: () => Date;
  id?: () => string;
  random?: () => number;
  politeDelayMs?: { min: number; max: number };
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  executionContext?: DiscoveryExecutionContext;
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

function createPoliteGate(
  delay: DiscoveryPipelineDependencies["politeDelayMs"],
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

function robotsOrigins(strategy: DiscoveryStrategy): string[] {
  const urls = strategy.tier === "sitemap"
    ? strategy.sitemapUrls
    : strategy.tier === "dom-crawl"
      ? strategy.startUrls
      : [];
  return [...new Set(urls.map((url) => new URL(url).origin))];
}

async function executionContextFor(
  strategy: DiscoveryStrategy,
  dependencies: DiscoveryPipelineDependencies,
): Promise<DiscoveryExecutionContext> {
  const beforeRequest = createPoliteGate(
    dependencies.politeDelayMs,
    dependencies.random ?? Math.random,
    dependencies.sleep ?? ((milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
    dependencies.clock ?? Date.now,
  );
  const context: DiscoveryExecutionContext = {
    ...dependencies.executionContext,
    beforeRequest,
  };
  if (dependencies.execute !== undefined) return context;
  const origins = robotsOrigins(strategy);
  if (origins.length === 0) return context;

  const robotsByOrigin = new Map<string, RobotsPolicy>();
  for (const origin of origins) {
    const robotsUrl = new URL("/robots.txt", origin).toString();
    await beforeRequest();
    const fetched = await fetchBounded(
      { url: robotsUrl, method: "GET" },
      strategy.allowedDomains,
      context,
    );
    if (!fetched.ok) throw new DiscoveryFailureError(fetched.failure);
    if (new URL(fetched.response.url).origin !== origin) {
      throw new DiscoveryFailureError({
        category: "domain-denied",
        message: "Robots response changed origin",
        responded: true,
        statusCode: fetched.response.status,
      });
    }
    try {
      robotsByOrigin.set(origin, RobotsPolicy.parse(robotsUrl, fetched.response.body));
    } catch (error) {
      throw new DiscoveryFailureError({
        category: "parse",
        message: "Robots policy could not be parsed",
        responded: true,
        statusCode: fetched.response.status,
      }, { cause: error });
    }
  }
  const singleRobots = robotsByOrigin.size === 1
    ? robotsByOrigin.values().next().value
    : undefined;
  return {
    ...context,
    ...(singleRobots === undefined ? {} : { robots: singleRobots }),
    robotsByOrigin,
  };
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
      MAX_DAILY_PAGES - attemptedForDay(dependencies.database, retailerId, day),
    ),
    Math.max(0, Math.trunc(dependencies.limit ?? MAX_DAILY_PAGES)),
  );
  const counters = { attempted: 0, ok: 0, failed: 0 };
  let finalError: { category: string; message: string } | undefined;
  let finishedAt = startedAt;
  let status = terminalStatus(0, 0);

  if (dependencies.dryRun === true) {
    return {
      id: runId,
      retailerId,
      stage: "discover",
      ...counters,
      planned: limit,
      successRate: 0,
      status: "completed",
      startedAt,
      finishedAt: now().toISOString(),
      dryRun: true,
    };
  }

  createRun(dependencies.database, {
    id: runId,
    retailerId,
    stage: "discover",
    collectionDay: day,
    strategyId: active.id,
    strategyVersion: active.version,
    startedAt,
  });

  try {
    try {
      if (limit > 0) {
        const context = await executionContextFor(active.strategy, dependencies);
        const refs = (dependencies.execute ?? ((strategy, executionContext) =>
          executeDiscovery(strategy, executionContext)))(active.strategy, context);
        const iterator = refs[Symbol.asyncIterator]();
        while (counters.attempted < limit) {
          const next = await iterator.next();
          if (next.done) break;
          const ref = next.value;
          counters.attempted += 1;
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
      }
    } catch (error) {
      counters.attempted += 1;
      counters.failed += 1;
      const failure = discoveryFailureFromUnknown(error);
      finalError = { category: failure.category, message: failure.message };
      try {
        insertRunFailure(dependencies.database, {
          runId,
          retailerId,
          failure,
          occurredAt: now().toISOString(),
          strategyId: active.id,
          strategyVersion: active.version,
        });
      } catch (persistenceError) {
        finalError = {
          category: "unknown",
          message: errorMessage(persistenceError),
        }
      }
    }
  } finally {
    finishedAt = now().toISOString();
    status = terminalStatus(counters.ok, counters.failed);
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
    stage: "discover",
    ...counters,
    successRate: counters.attempted === 0 ? 0 : counters.ok / counters.attempted,
    status,
    startedAt,
    finishedAt,
    dryRun: false,
  };
}
