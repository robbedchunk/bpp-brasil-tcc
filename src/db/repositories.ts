import type Database from "better-sqlite3";

export interface StatusReport {
  generatedAt: string;
  staleHeartbeat: boolean;
  retailers: Array<{
    id: string;
    name: string;
    active: boolean;
    degraded: boolean;
    latestRun: null | {
      collectionDay: string;
      attempted: number;
      ok: number;
      failed: number;
      successRate: number;
    };
  }>;
}

interface StatusRow {
  id: string;
  name: string;
  active: number;
  degraded: number;
  collection_day: string | null;
  attempted: number | null;
  ok: number | null;
  failed: number | null;
}

interface HeartbeatRow {
  completed_at: string | null;
}

const HEARTBEAT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export function readStatusReport(
  database: Database.Database,
  now: Date = new Date(),
): StatusReport {
  const rows = database
    .prepare(
      `SELECT
         retailer.id,
         retailer.name,
         retailer.active,
         retailer.degraded,
         latest.collection_day,
         latest.attempted,
         latest.ok,
         latest.failed
       FROM retailers AS retailer
       LEFT JOIN runs AS latest
         ON latest.id = (
           SELECT candidate.id
           FROM runs AS candidate
           WHERE candidate.retailer_id = retailer.id
             AND candidate.stage = 'collect'
           ORDER BY
             candidate.collection_day DESC,
             COALESCE(candidate.finished_at, candidate.started_at) DESC,
             candidate.id DESC
           LIMIT 1
         )
       ORDER BY retailer.name COLLATE NOCASE, retailer.id`,
    )
    .all() as StatusRow[];

  const heartbeat = database
    .prepare(
      `SELECT MAX(completed_at) AS completed_at
       FROM heartbeats
       WHERE pipeline = 'collect' AND status = 'completed'`,
    )
    .get() as HeartbeatRow;
  const completedAt = heartbeat.completed_at === null
    ? Number.NaN
    : Date.parse(heartbeat.completed_at);

  return {
    generatedAt: now.toISOString(),
    staleHeartbeat:
      !Number.isFinite(completedAt) || now.getTime() - completedAt > HEARTBEAT_STALE_AFTER_MS,
    retailers: rows.map((row) => {
      const attempted = row.attempted ?? 0;
      const latestRun = row.collection_day === null
        ? null
        : {
            collectionDay: row.collection_day,
            attempted,
            ok: row.ok ?? 0,
            failed: row.failed ?? 0,
            successRate: attempted === 0 ? 0 : (row.ok ?? 0) / attempted,
          };

      return {
        id: row.id,
        name: row.name,
        active: row.active === 1,
        degraded: row.degraded === 1,
        latestRun,
      };
    }),
  };
}
