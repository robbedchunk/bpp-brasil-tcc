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
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { sendAlertWithReceipt, type AlertSinkOptions } from "./alerts.js";
import { checkHeartbeat } from "./heartbeat.js";
import { resolveAcceptanceEvaluatedCommit } from "./evidence-cut.js";

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

const RECEIPT_KEYS = [
  "drill", "evaluatedCommit", "facts", "implementationSha256",
  "observedAt", "reasonCodes", "schemaVersion", "status",
] as const;
const ALERT_FACT_KEYS = [
  "accepted", "appendedLineSha256", "channel", "drillIdMatched",
  "drillIdSha256", "fallbackFileMode", "heartbeatRowsAfter",
  "heartbeatRowsBefore", "heartbeatRowsUnchanged", "httpStatus",
  "latestHeartbeatIdUnchanged", "simulatedStale",
] as const;
const BACKUP_FACT_KEYS = [
  "backupArtifactIdSha256", "backupSha256", "contentFingerprint", "countsMatched",
  "criticalTableCount", "criticalTableCountsSha256", "fileMode",
  "foreignKeyViolations", "integrityCheck", "restoreIntegrityCheck",
  "restoreTargetWasSource", "retentionSelfTestPassed", "sourceDatabaseSha256",
  "sourceFingerprintMatchesBackup", "sourceUnchangedAfterBackup",
] as const;
const HEX_64 = /^[a-f0-9]{64}$/u;
const HEX_40 = /^[a-f0-9]{40}$/u;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

export function validatePublicDrillReceipt(
  input: unknown,
  expectedDrill?: "alert" | "backup",
): PublicDrillReceipt {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Public drill receipt must be an object");
  }
  const value = input as Record<string, unknown>;
  if (!exactKeys(value, RECEIPT_KEYS)
    || value.schemaVersion !== 1
    || (value.drill !== "alert" && value.drill !== "backup")
    || (expectedDrill !== undefined && value.drill !== expectedDrill)
    || !["pass", "pending", "fail"].includes(String(value.status))
    || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))
    || typeof value.evaluatedCommit !== "string" || !HEX_40.test(value.evaluatedCommit)
    || typeof value.implementationSha256 !== "string" || !HEX_64.test(value.implementationSha256)
    || !Array.isArray(value.reasonCodes) || value.reasonCodes.some((code) => typeof code !== "string")
    || typeof value.facts !== "object" || value.facts === null || Array.isArray(value.facts)) {
    throw new TypeError("Public drill receipt has an invalid shape or drill kind");
  }
  const facts = value.facts as Record<string, unknown>;
  const factKeys = value.drill === "alert" ? ALERT_FACT_KEYS : BACKUP_FACT_KEYS;
  if (!exactKeys(facts, factKeys)) throw new TypeError("Public drill receipt facts are not exactly allowlisted");
  if (value.drill === "alert") {
    if (!["ntfy", "local", "local-after-ntfy-failure"].includes(String(facts.channel))
      || typeof facts.accepted !== "boolean"
      || (facts.httpStatus !== null && !Number.isInteger(facts.httpStatus))
      || (facts.fallbackFileMode !== null && facts.fallbackFileMode !== "0600")
      || (facts.appendedLineSha256 !== null && (typeof facts.appendedLineSha256 !== "string" || !HEX_64.test(facts.appendedLineSha256)))
      || typeof facts.heartbeatRowsBefore !== "number"
      || typeof facts.heartbeatRowsAfter !== "number"
      || ![facts.simulatedStale, facts.heartbeatRowsUnchanged, facts.latestHeartbeatIdUnchanged, facts.drillIdMatched].every((item) => typeof item === "boolean")
      || typeof facts.drillIdSha256 !== "string" || !HEX_64.test(facts.drillIdSha256)) {
      throw new TypeError("Public alert receipt facts are invalid");
    }
  } else if (![facts.backupArtifactIdSha256, facts.backupSha256, facts.contentFingerprint,
    facts.criticalTableCountsSha256, facts.sourceDatabaseSha256]
      .every((item) => typeof item === "string" && HEX_64.test(item))
    || facts.fileMode !== "0600"
    || facts.integrityCheck !== "ok" || facts.restoreIntegrityCheck !== "ok"
    || !Number.isInteger(facts.foreignKeyViolations) || !Number.isInteger(facts.criticalTableCount)
    || ![facts.countsMatched, facts.restoreTargetWasSource, facts.retentionSelfTestPassed,
      facts.sourceFingerprintMatchesBackup, facts.sourceUnchangedAfterBackup]
      .every((item) => typeof item === "boolean")) {
    throw new TypeError("Public backup receipt facts are invalid");
  }
  if (value.status === "pass") {
    if ((value.reasonCodes as unknown[]).length !== 0) throw new TypeError("Passing drill receipt cannot contain reason codes");
    if (value.drill === "alert") {
      const local = facts.channel === "local" || facts.channel === "local-after-ntfy-failure";
      const ntfy = facts.channel === "ntfy";
      if (facts.accepted !== true || facts.simulatedStale !== true
        || facts.heartbeatRowsUnchanged !== true || facts.latestHeartbeatIdUnchanged !== true
        || facts.drillIdMatched !== true
        || (ntfy && (!(typeof facts.httpStatus === "number") || facts.httpStatus < 200 || facts.httpStatus >= 300
          || facts.fallbackFileMode !== null || facts.appendedLineSha256 !== null))
        || (local && (facts.fallbackFileMode !== "0600"
          || typeof facts.appendedLineSha256 !== "string" || !HEX_64.test(facts.appendedLineSha256)
          || (facts.channel === "local" && facts.httpStatus !== null)
          || (facts.channel === "local-after-ntfy-failure" && typeof facts.httpStatus === "number"
            && facts.httpStatus >= 200 && facts.httpStatus < 300)))) {
        throw new TypeError("Passing alert receipt contradicts its delivery facts");
      }
    } else if (facts.integrityCheck !== "ok" || facts.restoreIntegrityCheck !== "ok"
      || facts.foreignKeyViolations !== 0 || facts.fileMode !== "0600"
      || facts.countsMatched !== true || facts.restoreTargetWasSource !== false
      || facts.retentionSelfTestPassed !== true || facts.sourceFingerprintMatchesBackup !== true
      || facts.sourceUnchangedAfterBackup !== true
      || facts.criticalTableCount !== CRITICAL_TABLES.length) {
      throw new TypeError("Passing backup receipt contradicts its integrity/restore facts");
    }
  }
  return input as PublicDrillReceipt;
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
const BACKUP_SCRIPT_PATH = fileURLToPath(new URL("../../ops/backup.sh", import.meta.url));
const CRITICAL_TABLES = [
  "schema_migrations",
  "runs",
  "observations",
  "run_failures",
  "classifications",
  "exploration_runs",
  "exploration_attempts",
  "healing_events",
  "retailer_state_events",
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
    return resolveAcceptanceEvaluatedCommit(root);
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
    validatePublicDrillReceipt(receipt, receipt.drill);
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

function semanticFingerprint(database: Database.Database): string {
  const digest = createHash("sha256");
  const schema = database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all() as Array<Record<string, unknown>>;
  digest.update(JSON.stringify(schema));
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    digest.update(`\0${name}\0`);
    const rows = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [
        key,
        Buffer.isBuffer(value) ? { base64: value.toString("base64") } : value,
      ]));
      digest.update(JSON.stringify(normalized));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
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
    fingerprint: semanticFingerprint(database),
  };
}

function retentionSelfTest(now: Date): boolean {
  try {
    execFileSync("bash", [BACKUP_SCRIPT_PATH, "--retention-self-test"], {
      env: { ...process.env, RETENTION_NOW_EPOCH: String(Math.floor(now.getTime() / 1_000)) },
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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
  const sourceAfterDatabase = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let sourceAfterFacts;
  try {
    sourceAfterFacts = databaseFacts(sourceAfterDatabase);
  } finally {
    sourceAfterDatabase.close();
  }
  const sourceUnchanged = sourceAfterFacts.fingerprint === sourceFacts.fingerprint
    && JSON.stringify(sourceAfterFacts.counts) === countsJson;
  const sourceFingerprintMatchesBackup = sourceFacts.fingerprint === backupFacts.fingerprint;
  const retentionPassed = retentionSelfTest(now);
  const coherent = sourceFacts.integrity === "ok"
    && backupFacts.integrity === "ok"
    && restoredFacts.integrity === "ok"
    && backupFacts.foreignKeyViolations === 0
    && restoredFacts.foreignKeyViolations === 0
    && JSON.stringify(backupFacts.counts) === countsJson
    && JSON.stringify(restoredFacts.counts) === countsJson
    && sourceFingerprintMatchesBackup
    && backupFacts.fingerprint === restoredFacts.fingerprint
    && sourceUnchanged
    && retentionPassed
    && Object.keys(sourceFacts.counts).length === CRITICAL_TABLES.length
    && fileMode === "0600"
    && resolve(restorePath) !== sourcePath;
  const receipt: PublicDrillReceipt = {
    schemaVersion: 1,
    drill: "backup",
    status: coherent ? "pass" : sourceUnchanged ? "fail" : "pending",
    observedAt: now.toISOString(),
    evaluatedCommit: commit(root),
    implementationSha256: implementationSha256(),
    reasonCodes: coherent ? [] : [sourceUnchanged ? "DATABASE_INTEGRITY_FAILED" : "SCHEDULED_RUN_NOT_YET_DUE"],
    facts: {
      backupArtifactIdSha256: sha256(filename),
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
      sourceFingerprintMatchesBackup,
      sourceUnchangedAfterBackup: sourceUnchanged,
      retentionSelfTestPassed: retentionPassed,
    },
  };
  writeReceipts(receipt, options);
  return receipt;
}
