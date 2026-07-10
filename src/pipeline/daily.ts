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
  runs: RunSummary[];
}

export interface DailyPipelineDependencies
  extends Omit<CollectionPipelineDependencies, "database"> {
  database: Database.Database;
  collect?: (retailerId: string) => Promise<RunSummary>;
}

export async function runDaily(
  dependencies: DailyPipelineDependencies,
): Promise<DailySummary> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const retailerIds = activeRetailerIds(dependencies.database);
  const runs: RunSummary[] = [];
  const collect = dependencies.collect ?? ((retailerId: string) =>
    runCollection(retailerId, dependencies));

  for (const retailerId of retailerIds) {
    runs.push(await collect(retailerId));
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
      details: { retailerIds, runIds: runs.map((run) => run.id) },
    });
  }

  return {
    startedAt,
    finishedAt,
    retailers: retailerIds.length,
    terminal,
    heartbeatRecorded,
    runs,
  };
}
