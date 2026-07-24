import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { openReadOnlyDatabase } from "../../../../../src/db/read-only.js";
import {
  ActionPreviewSchema,
  JobSchema,
  type ActionPreview,
  type Job,
} from "../../shared/contracts.js";

interface PreviewRow {
  preview_json: string;
  expires_at: string;
  consumed_at: string | null;
}

interface JobRow {
  job_json: string;
}

interface EventRow {
  sequence: number;
  event_json: string;
}

export interface StoredPreview {
  preview: ActionPreview;
  expiresAt: string;
  consumedAt: string | null;
}

export interface JobEvent {
  sequence: number;
  jobId: string;
  status: Job["status"];
  occurredAt: string;
}

export class JobStore {
  private readonly database: Database.Database | null;

  constructor(
    path: string,
    private readonly writable: boolean,
    now: () => Date = () => new Date(),
  ) {
    if (!writable && !existsSync(path)) {
      this.database = null;
      return;
    }
    if (writable) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.database = writable ? new Database(path) : openReadOnlyDatabase(path);
    if (!writable) return;
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS previews (
        id TEXT PRIMARY KEY,
        preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        job_json TEXT NOT NULL CHECK (json_valid(job_json)),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS job_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_by_created_at
        ON jobs (created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS job_events_by_job_sequence
        ON job_events (job_id, sequence);
    `);
    const interruptedAt = now().toISOString();
    const interrupted = this.database.prepare(`
      SELECT job_json FROM jobs WHERE status IN ('confirmed', 'started')
    `).all() as JobRow[];
    for (const row of interrupted) {
      const job = JobSchema.parse(JSON.parse(row.job_json));
      this.putJob({
        ...job,
        status: "interrupted_unknown",
        finishedAt: interruptedAt,
      });
    }
    chmodSync(path, 0o600);
  }

  savePreview(preview: ActionPreview): void {
    this.requireWritable().prepare(`
      INSERT INTO previews (id, preview_json, expires_at, consumed_at)
      VALUES (?, ?, ?, NULL)
    `).run(preview.id, JSON.stringify(preview), preview.expiresAt);
  }

  preview(id: string): StoredPreview | null {
    const row = this.database?.prepare(`
      SELECT preview_json, expires_at, consumed_at FROM previews WHERE id = ?
    `).get(id) as PreviewRow | undefined;
    return row === undefined
      ? null
      : {
          preview: ActionPreviewSchema.parse(JSON.parse(row.preview_json)),
          expiresAt: row.expires_at,
          consumedAt: row.consumed_at,
        };
  }

  consumePreview(id: string, consumedAt: string): boolean {
    return this.requireWritable().prepare(`
      UPDATE previews SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?
    `).run(consumedAt, id, consumedAt).changes === 1;
  }

  createJob(job: Job): void {
    const database = this.requireWritable();
    const serialized = JSON.stringify(JobSchema.parse(job));
    const transaction = database.transaction(() => {
      database.prepare(`
        INSERT INTO jobs (id, job_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(job.id, serialized, job.status, job.createdAt, job.createdAt);
      this.insertEvent(database, job.id, job.status, job.createdAt);
    });
    transaction.immediate();
  }

  job(id: string): Job | null {
    const row = this.database?.prepare(
      "SELECT job_json FROM jobs WHERE id = ?",
    ).get(id) as JobRow | undefined;
    return row === undefined ? null : JobSchema.parse(JSON.parse(row.job_json));
  }

  listJobs(limit = 100): Job[] {
    if (this.database === null) return [];
    const rows = this.database.prepare(`
      SELECT job_json FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(limit) as JobRow[];
    return rows.map((row) => JobSchema.parse(JSON.parse(row.job_json)));
  }

  updateJob(id: string, update: (job: Job) => Job, occurredAt: string): Job {
    const database = this.requireWritable();
    const transaction = database.transaction(() => {
      const current = this.job(id);
      if (current === null) throw new Error("Dashboard job does not exist");
      const next = JobSchema.parse(update(current));
      database.prepare(`
        UPDATE jobs SET job_json = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(next), next.status, occurredAt, id);
      if (next.status !== current.status) this.insertEvent(database, id, next.status, occurredAt);
      return next;
    });
    return transaction.immediate();
  }

  events(jobId: string, afterSequence = 0): JobEvent[] {
    if (this.database === null) return [];
    const rows = this.database.prepare(`
      SELECT sequence, event_json FROM job_events
      WHERE job_id = ? AND sequence > ?
      ORDER BY sequence
    `).all(jobId, afterSequence) as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      ...JSON.parse(row.event_json) as Omit<JobEvent, "sequence">,
    }));
  }

  close(): void {
    this.database?.close();
  }

  private putJob(job: Job): void {
    const database = this.requireWritable();
    database.prepare(`
      UPDATE jobs SET job_json = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(
      JSON.stringify(JobSchema.parse(job)),
      job.status,
      job.finishedAt ?? job.createdAt,
      job.id,
    );
    this.insertEvent(database, job.id, job.status, job.finishedAt ?? job.createdAt);
  }

  private insertEvent(
    database: Database.Database,
    jobId: string,
    status: Job["status"],
    occurredAt: string,
  ): void {
    const event = { jobId, status, occurredAt };
    database.prepare(`
      INSERT INTO job_events (job_id, event_json, occurred_at)
      VALUES (?, ?, ?)
    `).run(jobId, JSON.stringify(event), occurredAt);
  }

  private requireWritable(): Database.Database {
    if (!this.writable || this.database === null) {
      throw new Error("Dashboard job store is read-only");
    }
    return this.database;
  }
}
