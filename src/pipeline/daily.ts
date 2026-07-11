import type Database from "better-sqlite3";

import {
  activeRetailerIds,
  insertHeartbeat,
} from "../db/repositories.js";
import { redact } from "../ops/logger.js";
import type { ScheduledDailyInvocation } from "../ops/systemd-provenance.js";
import { runCollection, type CollectionPipelineDependencies } from "./collect.js";
import type { RunSummary } from "./discover.js";

export interface DailyOperationalFailure {
  kind: "collection" | "monitor";
  retailerId: string;
  runId: string | null;
  error: unknown;
}

export interface StoredDailyFailure {
  retailerId: string;
  message: string;
}

export interface DailySummary {
  status: "completed" | "partial" | "failed";
  startedAt: string;
  finishedAt: string;
  retailers: number;
  terminal: number;
  heartbeatRecorded: boolean;
  monitorFailedRunIds: string[];
  retailerFailures: StoredDailyFailure[];
  runs: RunSummary[];
}

export interface DailyPipelineDependencies
  extends Omit<CollectionPipelineDependencies, "database"> {
  database: Database.Database;
  /** Process-scoped systemd credentials verified by the CLI before network work. */
  scheduledInvocation?: ScheduledDailyInvocation;
  collect?: (retailerId: string) => Promise<RunSummary>;
  retailerOptions?: (
    retailerId: string,
  ) => Pick<CollectionPipelineDependencies, "politeDelayMs">;
  monitor?: (runId: string) => Promise<unknown>;
  reportOperationalFailure?: (
    failure: DailyOperationalFailure,
  ) => Promise<void>;
}

export class NoActiveRetailersError extends Error {
  constructor() {
    super("Daily collection is degraded: no active retailers are configured");
    this.name = "NoActiveRetailersError";
  }
}

export async function runDaily(
  dependencies: DailyPipelineDependencies,
): Promise<DailySummary> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const retailerIds = activeRetailerIds(dependencies.database);
  if (retailerIds.length === 0) throw new NoActiveRetailersError();
  const runs: RunSummary[] = [];
  const monitorFailedRunIds: string[] = [];
  const retailerFailures: StoredDailyFailure[] = [];
  const collect = dependencies.collect ?? ((retailerId: string) =>
    runCollection(retailerId, {
      ...dependencies,
      ...(dependencies.retailerOptions?.(retailerId) ?? {}),
    }));

  for (const retailerId of retailerIds) {
    let summary: RunSummary;
    try {
      summary = await collect(retailerId);
    } catch (error) {
      const sanitized = redact(error) as { message?: unknown };
      retailerFailures.push({
        retailerId,
        message: typeof sanitized?.message === "string"
          ? sanitized.message.slice(0, 500)
          : "Retailer collection failed outside its run lifecycle",
      });
      await dependencies.reportOperationalFailure?.({
        kind: "collection",
        retailerId,
        runId: null,
        error,
      }).catch(() => undefined);
      continue;
    }
    runs.push(summary);
    if (
      dependencies.dryRun !== true
      && summary.dryRun !== true
      && (summary.status === "completed"
        || summary.status === "partial"
        || summary.status === "failed")
    ) {
      try {
        await dependencies.monitor?.(summary.id);
      } catch (error) {
        // Healing/alerting is auxiliary: it must never stop later deterministic collection.
        monitorFailedRunIds.push(summary.id);
        await dependencies.reportOperationalFailure?.({
          kind: "monitor",
          retailerId,
          runId: summary.id,
          error,
        }).catch(() => undefined);
      }
    }
  }

  const terminal = runs.filter((run) =>
    run.status === "completed" || run.status === "partial" || run.status === "failed"
  ).length;
  const failedRuns = runs.filter((run) => run.status === "failed").length;
  const finishedAt = now().toISOString();
  const status: DailySummary["status"] = retailerFailures.length > 0
    ? (runs.length === 0 ? "failed" : "partial")
    : failedRuns === retailerIds.length && retailerIds.length > 0
      ? "failed"
      : failedRuns > 0 || monitorFailedRunIds.length > 0 || terminal !== retailerIds.length
      ? "partial"
      : "completed";
  const heartbeatRecorded = dependencies.dryRun !== true;
  if (heartbeatRecorded) {
    insertHeartbeat(dependencies.database, {
      pipeline: "collect",
      scheduledFor: startedAt,
      completedAt: finishedAt,
      status,
      details: {
        ...(dependencies.scheduledInvocation ?? { trigger: "manual" as const }),
        retailerIds,
        runIds: runs.map((run) => run.id),
        monitorFailedRunIds,
        retailerFailures,
      },
    });
  }

  return {
    status,
    startedAt,
    finishedAt,
    retailers: retailerIds.length,
    terminal,
    heartbeatRecorded,
    monitorFailedRunIds,
    retailerFailures,
    runs,
  };
}
