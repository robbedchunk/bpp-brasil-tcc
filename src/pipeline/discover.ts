import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  decideFoodAtHomeScope,
  MAX_FOOD_CATALOG_PRODUCTS,
  type CatalogScopeDecision,
} from "../catalog/scope.js";
import {
  activeCatalogProductCount,
  admitDiscoveryReference,
  admitRequest,
  catalogDisappearanceCandidateCount,
  createRun,
  finalizeDiscoveryRun,
  findActiveDiscoveryStrategy,
  insertRunFailure,
  remainingDiscoveryReferenceAdmissions,
  remainingRequestAdmissions,
  upsertDiscoveredProduct,
  type ActiveStrategy,
} from "../db/repositories.js";
import { executeDiscovery } from "../discovery/executor.js";
import type {
  DiscoveryCompletionEvidence,
  DiscoveryExecutionContext,
} from "../discovery/executor.js";
import {
  DiscoveryFailureError,
  discoveryFailureFromUnknown,
} from "../discovery/failure.js";
import { RobotsPolicy } from "../discovery/robots.js";
import { fetchBounded } from "../collection/http.js";
import type { DiscoveryStrategy } from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import { JsonlLogger } from "../ops/logger.js";

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

export interface DiscoveryRunSummary extends RunSummary {
  snapshotComplete: boolean;
  disappeared: number;
  inScope: number;
  outOfScope: number;
}

export interface DiscoveryPipelineDependencies {
  database: Database.Database;
  strategyOverride?: ActiveStrategy<DiscoveryStrategy>;
  preserveCatalog?: boolean;
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
  scopeDecider?: (ref: ProductRef) => CatalogScopeDecision;
  logDirectory?: string;
}

const MAX_DISCOVERY_PRODUCTS_PER_DAY = MAX_FOOD_CATALOG_PRODUCTS;

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

class RequestBudgetExhaustedError extends Error {
  constructor() {
    super("Daily discovery request budget is exhausted");
    this.name = "RequestBudgetExhaustedError";
  }
}

function causedByRequestBudgetExhaustion(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    if (current instanceof RequestBudgetExhaustedError) return true;
    seen.add(current);
    current = "cause" in current ? current.cause : null;
  }
  return false;
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
  admission: {
    runId: string;
    retailerId: string;
    collectionDay: string;
    now: () => Date;
  },
): Promise<DiscoveryExecutionContext> {
  const politeGate = createPoliteGate(
    dependencies.politeDelayMs,
    dependencies.random ?? Math.random,
    dependencies.sleep ?? ((milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
    dependencies.clock ?? Date.now,
  );
  const inheritedBeforeRequest = dependencies.executionContext?.beforeRequest;
  const beforeRequest = async (): Promise<void> => {
    await inheritedBeforeRequest?.();
    await politeGate();
    const result = admitRequest(dependencies.database, {
      runId: admission.runId,
      retailerId: admission.retailerId,
      collectionDay: admission.collectionDay,
      stage: "discover",
      admittedAt: admission.now().toISOString(),
    });
    if (!result.admitted) throw new RequestBudgetExhaustedError();
  };
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
): Promise<DiscoveryRunSummary> {
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.id ?? randomUUID;
  const startedAt = now().toISOString();
  const day = collectionDay(new Date(startedAt));
  const active = dependencies.strategyOverride
    ?? findActiveDiscoveryStrategy(dependencies.database, retailerId);
  if (
    active.retailerId !== retailerId
    || active.purpose !== "discovery"
  ) {
    throw new Error("Discovery strategy override identity does not match the run");
  }
  if (dependencies.strategyOverride !== undefined) {
    const staged = dependencies.database.prepare(`
      SELECT retailer_id AS retailerId, purpose, version, strategy_json AS strategyJson
      FROM strategies WHERE id = ?
    `).get(active.id) as {
      retailerId: string;
      purpose: string;
      version: number;
      strategyJson: string;
    } | undefined;
    if (
      staged === undefined
      || staged.retailerId !== active.retailerId
      || staged.purpose !== active.purpose
      || staged.version !== active.version
      || staged.strategyJson !== JSON.stringify(active.strategy)
    ) {
      throw new Error("Discovery strategy override must bind an immutable staged database row");
    }
  }
  const activeCatalogBefore = activeCatalogProductCount(
    dependencies.database,
    retailerId,
  );
  const runId = dependencies.dryRun === true ? `dry-run-${makeId()}` : makeId();
  const requestedProductLimit = Math.min(
    MAX_DISCOVERY_PRODUCTS_PER_DAY,
    Math.max(0, Math.trunc(
      dependencies.limit ?? MAX_DISCOVERY_PRODUCTS_PER_DAY,
    )),
  );
  const remainingDailyReferences = remainingDiscoveryReferenceAdmissions(
    dependencies.database,
    retailerId,
    day,
  );
  const limit = Math.min(requestedProductLimit, remainingDailyReferences);
  const remainingDailyRequests = remainingRequestAdmissions(
    dependencies.database,
    retailerId,
    day,
    "discover",
  );
  const counters = { attempted: 0, ok: 0, failed: 0 };
  let finalError: { category: string; message: string } | undefined;
  let finishedAt = startedAt;
  let status = terminalStatus(0, 0);
  let inScope = 0;
  let outOfScope = 0;
  let iteratorCompleted = false;
  const completionState: { evidence: DiscoveryCompletionEvidence | null } = {
    evidence: null,
  };
  let snapshotComplete = false;
  let disappeared = 0;
  let referenceBudgetExhausted = false;

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
      snapshotComplete: false,
      disappeared: 0,
      inScope: 0,
      outOfScope: 0,
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
  const logger = dependencies.logDirectory === undefined
    ? null
    : new JsonlLogger({
        directory: dependencies.logDirectory,
        basename: `discover-${runId}`,
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
      loggingErrors.push(errorMessage(error));
    }
  };
  await log("info", "run.started", {
    runId,
    retailerId,
    stage: "discover",
    strategyId: active.id,
    strategyVersion: active.version,
    limit,
  });

  try {
    try {
      if (loggingErrors.length > 0) {
        throw new Error(loggingErrors[0] ?? "Discovery run logging initialization failed");
      }
      if (limit > 0 && remainingDailyRequests > 0) {
        const context = await executionContextFor(active.strategy, dependencies, {
          runId,
          retailerId,
          collectionDay: day,
          now,
        });
        context.stopAfterProducts = Math.min(
          context.stopAfterProducts ?? limit,
          limit,
        );
        const inheritedCompletionReporter = context.reportCompletion;
        context.reportCompletion = (evidence) => {
          inheritedCompletionReporter?.(evidence);
          completionState.evidence = evidence;
        };
        const refs = (dependencies.execute ?? ((strategy, executionContext) =>
          executeDiscovery(strategy, executionContext)))(active.strategy, context);
        const iterator = refs[Symbol.asyncIterator]();
        while (counters.attempted < limit) {
          const next = await iterator.next();
          if (next.done) {
            iteratorCompleted = true;
            break;
          }
          const ref = next.value;
          const referenceAdmission = admitDiscoveryReference(dependencies.database, {
            runId,
            retailerId,
            collectionDay: day,
            canonicalUrl: typeof ref.canonicalUrl === "string" ? ref.canonicalUrl : null,
            admittedAt: now().toISOString(),
          });
          if (!referenceAdmission.admitted) {
            referenceBudgetExhausted = true;
            completionState.evidence = {
              complete: false,
              reason: "product_cap_reached",
            };
            break;
          }
          counters.attempted += 1;
          try {
            const scope = (dependencies.scopeDecider ?? decideFoodAtHomeScope)(ref);
            upsertDiscoveredProduct(
              dependencies.database,
              retailerId,
              ref,
              now().toISOString(),
              { runId, scope },
            );
            counters.ok += 1;
            if (scope.inScope) inScope += 1;
            else outOfScope += 1;
            await log("info", "product.discovered", {
              runId,
              retailerId,
              inScope: scope.inScope,
              scopeReason: scope.reason,
              sourceCategory: ref.sourceCategory,
            });
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
        if (
          counters.attempted >= limit
          && remainingDailyReferences <= requestedProductLimit
        ) {
          referenceBudgetExhausted = true;
          completionState.evidence = {
            complete: false,
            reason: "product_cap_reached",
          };
        }
        if (counters.attempted >= limit || referenceBudgetExhausted) {
          try {
            await iterator.return?.();
          } catch {
            // Iterator cleanup is not another page attempt and cannot exceed the cap.
          }
        }
      } else if (remainingDailyRequests === 0) {
        completionState.evidence = {
          complete: false,
          reason: "request_cap_reached",
        };
      } else if (remainingDailyReferences === 0 && requestedProductLimit > 0) {
        referenceBudgetExhausted = true;
        completionState.evidence = {
          complete: false,
          reason: "product_cap_reached",
        };
      }
    } catch (error) {
      if (causedByRequestBudgetExhaustion(error)) {
        completionState.evidence = {
          complete: false,
          reason: "request_cap_reached",
        };
      } else {
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
          };
        }
      }
    }
  } finally {
    finishedAt = now().toISOString();
    status = finalError === undefined
      ? terminalStatus(counters.ok, counters.failed)
      : counters.ok > 0 ? "partial" : "failed";
    snapshotComplete = limit > 0
      && iteratorCompleted
      && completionState.evidence?.complete === true
      && counters.failed === 0
      && finalError === undefined;
    let completionReason = completionState.evidence?.reason === "request_cap_reached"
      || completionState.evidence?.reason === "product_cap_reached"
      ? completionState.evidence.reason
      : limit === 0
        ? "discovery_budget_exhausted"
        : finalError !== undefined
          ? "pipeline_failure"
          : !iteratorCompleted
            ? "run_limit_reached"
            : completionState.evidence?.reason ?? "completion_unverified";
    if (dependencies.preserveCatalog === true) {
      snapshotComplete = false;
      completionReason = "candidate_validation_preflight";
    } else if (snapshotComplete && counters.ok === 0) {
      snapshotComplete = false;
      completionReason = "empty_snapshot_guard";
    } else if (snapshotComplete && activeCatalogBefore > 0) {
      const disappearanceCandidates = catalogDisappearanceCandidateCount(
        dependencies.database,
        retailerId,
        runId,
      );
      const safeDisappearanceLimit = Math.max(
        1,
        Math.floor(activeCatalogBefore * 0.2),
      );
      if (disappearanceCandidates > safeDisappearanceLimit) {
        snapshotComplete = false;
        completionReason = "catastrophic_shrink_guard";
      }
    }
    if (loggingErrors.length > 0) {
      snapshotComplete = false;
      completionReason = "logging_failure";
      finalError ??= {
        category: "unknown",
        message: loggingErrors[0] ?? "Run logging failed",
      };
      status = counters.ok > 0 ? "partial" : "failed";
    }
    await log(status === "completed" ? "info" : "warning", "run.finished", {
      runId,
      retailerId,
      stage: "discover",
      status,
      ...counters,
      inScope,
      outOfScope,
      snapshotComplete,
      disappeared: snapshotComplete
        ? catalogDisappearanceCandidateCount(dependencies.database, retailerId, runId)
        : 0,
      completionReason,
    });
    if (loggingErrors.length > 0) {
      snapshotComplete = false;
      completionReason = "logging_failure";
      finalError ??= {
        category: "unknown",
        message: loggingErrors[0] ?? "Run logging failed",
      };
      status = counters.ok > 0 ? "partial" : "failed";
    }
    disappeared = finalizeDiscoveryRun(dependencies.database, {
      snapshot: {
        runId,
        retailerId,
        complete: snapshotComplete,
        completionReason,
        discovered: counters.ok,
        inScope,
        outOfScope,
        completedAt: finishedAt,
      },
      counters,
      status,
      finishedAt,
      ...(finalError === undefined ? {} : { error: finalError }),
    });
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
    snapshotComplete,
    disappeared,
    inScope,
    outOfScope,
  };
}
