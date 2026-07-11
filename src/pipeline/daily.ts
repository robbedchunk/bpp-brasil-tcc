import type Database from "better-sqlite3";

import {
  activeRetailerIds,
  insertHeartbeat,
} from "../db/repositories.js";
import { runCollection, type CollectionPipelineDependencies } from "./collect.js";
import type { RunSummary } from "./discover.js";

export interface DailySummary {
  startedAt: string;
  finishedAt: string;
  retailers: number;
  terminal: number;
  heartbeatRecorded: boolean;
  monitorFailedRunIds: string[];
  runs: RunSummary[];
}

export interface DailyPipelineDependencies
  extends Omit<CollectionPipelineDependencies, "database"> {
  database: Database.Database;
  /**
   * Immutable invocation provenance recorded with the completion heartbeat.
   * Only the installed timer service is allowed to supply `systemd-timer`;
   * ordinary CLI/API calls deliberately default to `manual`.
   */
  trigger?: "manual" | "systemd-timer";
  collect?: (retailerId: string) => Promise<RunSummary>;
  retailerOptions?: (
    retailerId: string,
  ) => Pick<CollectionPipelineDependencies, "politeDelayMs">;
  monitor?: (runId: string) => Promise<unknown>;
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
  const collect = dependencies.collect ?? ((retailerId: string) =>
    runCollection(retailerId, {
      ...dependencies,
      ...(dependencies.retailerOptions?.(retailerId) ?? {}),
    }));

  for (const retailerId of retailerIds) {
    const summary = await collect(retailerId);
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
      } catch {
        // Healing/alerting is auxiliary: it must never stop later deterministic collection.
        monitorFailedRunIds.push(summary.id);
      }
    }
  }

  const terminal = runs.filter((run) =>
    run.status === "completed" || run.status === "partial" || run.status === "failed"
  ).length;
  const finishedAt = now().toISOString();
  const heartbeatRecorded =
    dependencies.dryRun !== true && terminal === retailerIds.length;
  if (heartbeatRecorded) {
    insertHeartbeat(dependencies.database, {
      pipeline: "collect",
      scheduledFor: startedAt,
      completedAt: finishedAt,
      status: "completed",
      details: {
        trigger: dependencies.trigger ?? "manual",
        ...(dependencies.trigger === "systemd-timer"
          ? { timerUnit: "precos-daily.timer" }
          : {}),
        retailerIds,
        runIds: runs.map((run) => run.id),
        monitorFailedRunIds,
      },
    });
  }

  return {
    startedAt,
    finishedAt,
    retailers: retailerIds.length,
    terminal,
    heartbeatRecorded,
    monitorFailedRunIds,
    runs,
  };
}
