import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import { sendAlertWithReceipt, type AlertSinkOptions } from "./alerts.js";
import { checkHeartbeat } from "./heartbeat.js";

export type DrillStatus = "pass" | "pending" | "fail";

export interface PublicDrillReceipt {
  schemaVersion: 1;
  drill: "alert" | "backup";
  status: DrillStatus;
  observedAt: string;
  evaluatedCommit: string;
  implementationSha256: string;
  reasonCodes: string[];
  facts: Record<string, string | number | boolean | null>;
}

interface ReceiptPaths {
  privateReceiptPath?: string;
  publicReceiptPath?: string;
}

export interface AlertDrillOptions extends ReceiptPaths {
  projectRoot: string;
  databasePath: string;
  fallbackPath: string;
  ntfyTopic?: string;
  fetch?: AlertSinkOptions["fetch"];
  now: () => Date;
  drillId?: () => string;
}

export interface BackupDrillOptions extends ReceiptPaths {
  projectRoot: string;
  databasePath: string;
  backupDirectory: string;
  now: () => Date;
  drillId?: () => string;
}

const IMPLEMENTATION_PATH = new URL(import.meta.url);
const CRITICAL_TABLES = [
  "schema_migrations",
  "runs",
  "observations",
  "run_failures",
  "classifications",
  "exploration_runs",
  "exploration_attempts",
  "healing_events",
  "heartbeats",
  "cost_ledger",
] as const;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function implementationSha256(): string {
  return sha256(readFileSync(IMPLEMENTATION_PATH));
}

function commit(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "0".repeat(40);
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function safeDatabasePath(root: string, candidate: string): string {
  const resolvedRoot = realpathSync(root);
  if (!existsSync(candidate)) throw new Error("acceptance drill database is absent");
  const resolvedDatabase = realpathSync(candidate);
  if (!inside(resolvedRoot, resolvedDatabase)) {
    throw new Error("acceptance drill database resolves outside the project root");
  }
  return resolvedDatabase;
}

function writeReceipts(receipt: PublicDrillReceipt, paths: ReceiptPaths): void {
  const body = `${JSON.stringify(receipt)}\n`;
  if (paths.privateReceiptPath !== undefined) {
    mkdirSync(resolve(paths.privateReceiptPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(paths.privateReceiptPath, body, { mode: 0o600 });
    chmodSync(paths.privateReceiptPath, 0o600);
  }
  if (paths.publicReceiptPath !== undefined && receipt.status === "pass") {
    mkdirSync(resolve(paths.publicReceiptPath, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(paths.publicReceiptPath, body, { mode: 0o644 });
  }
}

interface HeartbeatIdentity {
  count: number;
  latestId: string | null;
}

function heartbeatIdentity(database: Database.Database): HeartbeatIdentity {
  return database.prepare(`
    SELECT COUNT(*) AS count,
      (SELECT id FROM heartbeats ORDER BY completed_at DESC, id DESC LIMIT 1) AS latestId
    FROM heartbeats
  `).get() as HeartbeatIdentity;
}

export async function runAlertDrill(options: AlertDrillOptions): Promise<PublicDrillReceipt> {
  const root = realpathSync(options.projectRoot);
  const path = safeDatabasePath(root, options.databasePath);
  const now = options.now();
  const drillId = (options.drillId ?? randomUUID)();
  const database = new Database(path, { readonly: true, fileMustExist: true });
  let before: HeartbeatIdentity;
  try {
    before = heartbeatIdentity(database);
  } finally {
    database.close();
  }

  const simulatedHeartbeat = new Date(now.getTime() - 25 * 60 * 60 * 1_000);
  const heartbeatCheck = checkHeartbeat(now, simulatedHeartbeat);
  const delivery = await sendAlertWithReceipt({
    ...(options.ntfyTopic === undefined ? {} : { ntfyTopic: options.ntfyTopic }),
    fallbackPath: options.fallbackPath,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now: options.now,
  }, {
    severity: "warning",
    title: `[DRILL] stale heartbeat ${drillId}`,
    message: `Safe acceptance drill ${drillId}; no live heartbeat was changed.`,
    details: { drillId, stale: heartbeatCheck.stale, ageMs: heartbeatCheck.ageMs },
  });

  const afterDatabase = new Database(path, { readonly: true, fileMustExist: true });
  let after: HeartbeatIdentity;
  try {
    after = heartbeatIdentity(afterDatabase);
  } finally {
    afterDatabase.close();
  }
  const unchanged = before.count === after.count && before.latestId === after.latestId;
  let drillIdMatched = delivery.channel === "ntfy";
  if (delivery.channel !== "ntfy") {
    const lines = readFileSync(options.fallbackPath, "utf8").trimEnd().split("\n");
    const lastLine = `${lines.at(-1) ?? ""}\n`;
    drillIdMatched = lastLine.includes(drillId)
      && sha256(lastLine) === delivery.appendedLineSha256;
  }
  const passed = delivery.accepted && heartbeatCheck.stale && unchanged && drillIdMatched;
  const receipt: PublicDrillReceipt = {
    schemaVersion: 1,
    drill: "alert",
    status: passed ? "pass" : "fail",
    observedAt: now.toISOString(),
    evaluatedCommit: commit(root),
    implementationSha256: implementationSha256(),
    reasonCodes: passed ? [] : ["EVIDENCE_CONTRADICTION"],
    facts: {
      channel: delivery.channel,
      accepted: delivery.accepted,
      httpStatus: delivery.httpStatus,
      fallbackFileMode: delivery.fallbackFileMode,
      appendedLineSha256: delivery.appendedLineSha256,
      simulatedStale: heartbeatCheck.stale,
      heartbeatRowsBefore: before.count,
      heartbeatRowsAfter: after.count,
      heartbeatRowsUnchanged: unchanged,
      latestHeartbeatIdUnchanged: before.latestId === after.latestId,
      drillIdMatched,
      drillIdSha256: sha256(drillId),
    },
  };
  writeReceipts(receipt, options);
  return receipt;
}

function tableCounts(database: Database.Database): Record<string, number> {
  const result: Record<string, number> = {};
  for (const table of CRITICAL_TABLES) {
    const exists = database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table);
    if (exists !== undefined) {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
      result[table] = row.count;
    }
  }
  return result;
}

function databaseFacts(database: Database.Database): {
  integrity: string;
  foreignKeyViolations: number;
  counts: Record<string, number>;
  fingerprint: string;
} {
  const integrityRows = database.pragma("integrity_check") as Array<Record<string, string>>;
  const integrity = String(Object.values(integrityRows[0] ?? {})[0] ?? "invalid");
  const foreignKeys = database.pragma("foreign_key_check") as unknown[];
  const counts = tableCounts(database);
  return {
    integrity,
    foreignKeyViolations: foreignKeys.length,
    counts,
    fingerprint: sha256(database.serialize()),
  };
}

export async function runBackupDrill(options: BackupDrillOptions): Promise<PublicDrillReceipt> {
  const root = realpathSync(options.projectRoot);
  const sourcePath = safeDatabasePath(root, options.databasePath);
  const backupRoot = resolve(options.backupDirectory);
  if (!inside(root, backupRoot)) throw new Error("backup directory resolves outside the project root");
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  if (!inside(root, realpathSync(backupRoot))) {
    throw new Error("backup directory resolves outside the project root");
  }
  const now = options.now();
  const drillId = (options.drillId ?? randomUUID)();
  const filename = `precos-drill-${now.toISOString().replaceAll(/[^0-9]/gu, "").slice(0, 14)}-${drillId}.sqlite`;
  const backupPath = join(backupRoot, filename);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let sourceFacts;
  try {
    sourceFacts = databaseFacts(source);
    if (sourceFacts.integrity !== "ok" || sourceFacts.foreignKeyViolations !== 0) {
      throw new Error("source database failed integrity checks");
    }
    await source.backup(backupPath);
  } finally {
    source.close();
  }
  chmodSync(backupPath, 0o600);

  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  let backupFacts;
  const restoreRoot = mkdtempSync(join(tmpdir(), "acceptance-restore-read-"));
  const restorePath = join(restoreRoot, "restored.sqlite");
  try {
    backupFacts = databaseFacts(backup);
    await backup.backup(restorePath);
  } finally {
    backup.close();
  }
  const restored = new Database(restorePath, { readonly: true, fileMustExist: true });
  let restoredFacts;
  try {
    restoredFacts = databaseFacts(restored);
  } finally {
    restored.close();
    rmSync(restoreRoot, { recursive: true, force: true });
  }

  const fileMode = (statSync(backupPath).mode & 0o777).toString(8).padStart(4, "0");
  const countsJson = JSON.stringify(sourceFacts.counts);
  const coherent = sourceFacts.integrity === "ok"
    && backupFacts.integrity === "ok"
    && restoredFacts.integrity === "ok"
    && backupFacts.foreignKeyViolations === 0
    && restoredFacts.foreignKeyViolations === 0
    && JSON.stringify(backupFacts.counts) === countsJson
    && JSON.stringify(restoredFacts.counts) === countsJson
    && backupFacts.fingerprint === restoredFacts.fingerprint
    && fileMode === "0600"
    && resolve(restorePath) !== sourcePath;
  const receipt: PublicDrillReceipt = {
    schemaVersion: 1,
    drill: "backup",
    status: coherent ? "pass" : "fail",
    observedAt: now.toISOString(),
    evaluatedCommit: commit(root),
    implementationSha256: implementationSha256(),
    reasonCodes: coherent ? [] : ["DATABASE_INTEGRITY_FAILED"],
    facts: {
      backupPath: relative(root, backupPath).split(sep).join("/"),
      integrityCheck: backupFacts.integrity,
      foreignKeyViolations: backupFacts.foreignKeyViolations,
      restoreIntegrityCheck: restoredFacts.integrity,
      restoreTargetWasSource: false,
      fileMode,
      sourceDatabaseSha256: sourceFacts.fingerprint,
      backupSha256: sha256(readFileSync(backupPath)),
      contentFingerprint: backupFacts.fingerprint,
      criticalTableCount: Object.keys(sourceFacts.counts).length,
      criticalTableCountsSha256: sha256(countsJson),
      countsMatched: JSON.stringify(backupFacts.counts) === countsJson
        && JSON.stringify(restoredFacts.counts) === countsJson,
    },
  };
  writeReceipts(receipt, options);
  return receipt;
}
