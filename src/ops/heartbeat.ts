import type Database from "better-sqlite3";

import { insertHeartbeat } from "../db/repositories.js";

const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface HeartbeatCheck {
  stale: boolean;
  ageMs: number | null;
  lastSuccessAt: string | null;
}

export function checkHeartbeat(
  now: Date,
  lastSuccess: Date | null,
): HeartbeatCheck {
  if (lastSuccess === null || !Number.isFinite(lastSuccess.getTime())) {
    return { stale: true, ageMs: null, lastSuccessAt: null };
  }
  const ageMs = Math.max(0, now.getTime() - lastSuccess.getTime());
  return {
    stale: ageMs > STALE_AFTER_MS,
    ageMs,
    lastSuccessAt: lastSuccess.toISOString(),
  };
}

export function recordHeartbeat(
  database: Database.Database,
  input: {
    pipeline: string;
    scheduledFor: string;
    completedAt: string;
    details: unknown;
  },
): void {
  insertHeartbeat(database, {
    pipeline: input.pipeline,
    scheduledFor: input.scheduledFor,
    completedAt: input.completedAt,
    status: "completed",
    details: input.details,
  });
}

export function latestSuccessfulHeartbeat(
  database: Database.Database,
  pipeline: string,
  options: { scheduledOnly?: boolean } = {},
): Date | null {
  const row = database.prepare(
    `SELECT completed_at
     FROM heartbeats
     WHERE pipeline = ? AND status = 'completed'
       AND COALESCE(json_array_length(details_json, '$.monitorFailedRunIds'), 0) = 0
       AND COALESCE(json_array_length(details_json, '$.retailerFailures'), 0) = 0
       AND (? = 0 OR (
         json_extract(details_json, '$.trigger') = 'systemd-timer'
         AND json_extract(details_json, '$.timerUnit') = 'precos-daily.timer'
       ))
     ORDER BY completed_at DESC, id DESC
     LIMIT 1`,
  ).get(pipeline, options.scheduledOnly === true ? 1 : 0) as { completed_at: string } | undefined;
  return row === undefined ? null : new Date(row.completed_at);
}
