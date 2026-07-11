import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
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

import { EXPECTED_SCHEMA_MIGRATIONS } from "../db/database.js";
import { resolveAcceptanceEvaluatedCommit } from "./evidence-cut.js";
import {
  canonicalReleaseJson,
  validateFrozenRelease,
  type ReleaseManifest,
} from "./release-manifest.js";

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
  "dbInitCommandSha256", "dbInitExitCode", "execMainCode",
  "execMainStatus", "heartbeatCliArtifactSha256", "heartbeatCommandSha256",
  "heartbeatExitCode", "heartbeatLastSuccessAt", "heartbeatStale",
  "heartbeatStdoutSha256", "invocationId", "isolatedAlertLineMatched",
  "isolatedAlertLineSha256", "isolatedAlertMode", "isolatedHeartbeatRows",
  "isolatedSchemaMigrationCount", "isolatedSchemaVersion", "journalBytes",
  "journalInvocationMatched", "journalSha256", "protocolVersion", "releaseArtifactSetSha256",
  "releaseId", "releaseManifestSha256", "sourceHeartbeatRowsAfter",
  "sourceHeartbeatRowsBefore", "sourceHeartbeatSnapshotSha256After",
  "sourceHeartbeatSnapshotSha256Before", "sourceHeartbeatsUnchanged",
  "systemdResult", "systemdRunCommandSha256", "systemdRunExitCode",
  "transientUnit",
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
    if (facts.protocolVersion !== 2
      || typeof facts.releaseId !== "string" || !/^[a-f0-9]{32}$/u.test(facts.releaseId)
      || typeof facts.transientUnit !== "string"
      || !/^precos-alert-drill-[a-f0-9]{12}\.service$/u.test(facts.transientUnit)
      || typeof facts.invocationId !== "string" || !/^[a-f0-9]{32}$/u.test(facts.invocationId)
      || facts.systemdResult !== "signal" || facts.execMainCode !== "killed"
      || facts.execMainStatus !== 9
      || !Number.isInteger(facts.systemdRunExitCode)
      || !Number.isInteger(facts.dbInitExitCode)
      || !Number.isInteger(facts.heartbeatExitCode)
      || facts.heartbeatLastSuccessAt !== null
      || facts.isolatedAlertMode !== "0600"
      || !Number.isInteger(facts.sourceHeartbeatRowsBefore)
      || !Number.isInteger(facts.sourceHeartbeatRowsAfter)
      || !Number.isInteger(facts.isolatedHeartbeatRows)
      || !Number.isInteger(facts.isolatedSchemaMigrationCount)
      || !Number.isInteger(facts.isolatedSchemaVersion)
      || !Number.isInteger(facts.journalBytes)
      || ![
        facts.releaseManifestSha256, facts.releaseArtifactSetSha256,
        facts.heartbeatCliArtifactSha256, facts.systemdRunCommandSha256,
        facts.dbInitCommandSha256, facts.heartbeatCommandSha256,
        facts.heartbeatStdoutSha256, facts.journalSha256,
        facts.isolatedAlertLineSha256,
        facts.sourceHeartbeatSnapshotSha256Before,
        facts.sourceHeartbeatSnapshotSha256After,
      ].every((item) => typeof item === "string" && HEX_64.test(item))
      || ![
        facts.heartbeatStale, facts.isolatedAlertLineMatched,
        facts.journalInvocationMatched, facts.sourceHeartbeatsUnchanged,
      ].every((item) => typeof item === "boolean")) {
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
      if (facts.systemdRunExitCode === 0
        || facts.dbInitExitCode !== 0 || facts.heartbeatExitCode !== 0
        || facts.heartbeatStale !== true || facts.heartbeatLastSuccessAt !== null
        || facts.journalBytes === 0 || facts.journalInvocationMatched !== true
        || facts.isolatedAlertLineMatched !== true
        || facts.isolatedHeartbeatRows !== 0
        || facts.sourceHeartbeatRowsBefore !== facts.sourceHeartbeatRowsAfter
        || facts.sourceHeartbeatSnapshotSha256Before
          !== facts.sourceHeartbeatSnapshotSha256After
        || facts.sourceHeartbeatsUnchanged !== true) {
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

interface AlertDrillReleaseBinding {
  releasePath: string;
  releaseId: string;
  sourceCommit: string;
  manifestSha256: string;
  artifactSetSha256: string;
  cliArtifactSha256: string;
  cliPath: string;
  nodePath: string;
}

interface DrillCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DrillCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AlertDrillTestRunner {
  resolveRelease(input: {
    projectRoot: string;
    evaluatedCommit: string;
    now: Date;
  }): AlertDrillReleaseBinding;
  run(
    command: string,
    args: readonly string[],
    options: DrillCommandOptions,
  ): DrillCommandResult | Promise<DrillCommandResult>;
}

export interface AlertDrillOptions extends ReceiptPaths {
  projectRoot: string;
  databasePath: string;
  now: () => Date;
  drillId?: () => string;
  /** Explicit Vitest-only process seam. Production always uses native systemd
   * and the installed signed frozen release. */
  testRunner?: AlertDrillTestRunner;
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

interface HeartbeatSnapshot extends HeartbeatIdentity {
  sha256: string;
}

function heartbeatSnapshot(databasePath: string): HeartbeatSnapshot {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const identity = heartbeatIdentity(database);
    const rows = database.prepare(`
      SELECT id, pipeline, retailer_id, run_id, scheduled_for, completed_at,
             status, details_json, created_at
      FROM heartbeats ORDER BY id
    `).all();
    return { ...identity, sha256: sha256(JSON.stringify(rows)) };
  } finally {
    database.close();
  }
}

function commandSha256(command: string, args: readonly string[]): string {
  return sha256([command, ...args].join("\0"));
}

function exactIso(value: unknown, now: Date): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now.getTime()
    && new Date(parsed).toISOString() === value;
}

function installedRelease(
  root: string,
  evaluatedCommit: string,
  now: Date,
): AlertDrillReleaseBinding {
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Alert drill requires the provisioned Node.js 24 runtime");
  }
  const receiptPath = join(root, "var/operations/systemd-install.json");
  if (!existsSync(receiptPath)) throw new Error("Systemd installation receipt is absent");
  const receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()
    || (receiptStat.mode & 0o777) !== 0o600) {
    throw new Error("Systemd installation receipt is not a private regular file");
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  if (!exactKeys(receipt, [
    "deployedAt", "releaseId", "releaseManifestSha256", "releasePath",
    "scheduleActivatedAt", "schemaVersion", "sourceCommit", "unitSetSha256", "units",
  ])
    || receipt.schemaVersion !== 2
    || !exactIso(receipt.deployedAt, now) || !exactIso(receipt.scheduleActivatedAt, now)
    || typeof receipt.sourceCommit !== "string" || !HEX_40.test(receipt.sourceCommit)
    || receipt.sourceCommit !== evaluatedCommit
    || typeof receipt.releaseId !== "string" || !/^[a-f0-9]{32}$/u.test(receipt.releaseId)
    || typeof receipt.releasePath !== "string" || !isAbsolute(receipt.releasePath)
    || resolve(receipt.releasePath) !== receipt.releasePath
    || typeof receipt.releaseManifestSha256 !== "string"
    || !HEX_64.test(receipt.releaseManifestSha256)
    || typeof receipt.unitSetSha256 !== "string" || !HEX_64.test(receipt.unitSetSha256)
    || !Array.isArray(receipt.units) || receipt.units.length === 0) {
    throw new Error("Systemd installation receipt does not bind the current release");
  }
  for (const unit of receipt.units) {
    if (typeof unit !== "object" || unit === null || Array.isArray(unit)
      || !exactKeys(unit as Record<string, unknown>, ["name", "sha256"])
      || typeof (unit as { name?: unknown }).name !== "string"
      || typeof (unit as { sha256?: unknown }).sha256 !== "string"
      || !HEX_64.test((unit as { sha256: string }).sha256)) {
      throw new Error("Systemd installation receipt contains a malformed unit binding");
    }
  }
  const manifest = validateFrozenRelease({
    releasePath: receipt.releasePath,
    publicKeyPath: join(root, "ops/validation-attestation-public.pem"),
    expectedSourceCommit: evaluatedCommit,
    expectedReleaseId: receipt.releaseId,
    expectedSourceRoot: root,
  });
  const manifestPath = join(receipt.releasePath, "release-manifest.json");
  if (sha256(readFileSync(manifestPath)) !== receipt.releaseManifestSha256
    || manifest.deployedAt !== receipt.deployedAt) {
    throw new Error("Installed release manifest does not match its installation receipt");
  }
  const cliArtifact = manifest.artifacts.find(({ path }) => path === "dist/cli.js");
  if (cliArtifact === undefined) throw new Error("Frozen release does not contain dist/cli.js");
  return {
    releasePath: receipt.releasePath,
    releaseId: receipt.releaseId,
    sourceCommit: receipt.sourceCommit,
    manifestSha256: receipt.releaseManifestSha256,
    artifactSetSha256: manifest.artifactSetSha256,
    cliArtifactSha256: cliArtifact.sha256,
    cliPath: join(receipt.releasePath, "dist/cli.js"),
    nodePath: process.execPath,
  };
}

function nativeCommand(
  command: string,
  args: readonly string[],
  options: DrillCommandOptions,
): DrillCommandResult {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1_024 * 1_024,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      exitCode: typeof failure.status === "number" ? failure.status : 1,
      stdout: Buffer.isBuffer(failure.stdout)
        ? failure.stdout.toString("utf8") : failure.stdout ?? "",
      stderr: Buffer.isBuffer(failure.stderr)
        ? failure.stderr.toString("utf8") : failure.stderr ?? "",
    };
  }
}

function systemdFailureCommand(unit: string): { command: string; args: string[] } {
  return {
    command: "systemd-run",
    args: [
      "--user",
      `--unit=${unit}`,
      "--wait",
      "--expand-environment=no",
      "--property=Type=exec",
      "/bin/sh",
      "-c",
      'kill -KILL "$$"',
    ],
  };
}

function parseProperties(output: string): Map<string, string> {
  return new Map(output.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function journalMatchesInvocation(output: string, invocationId: string): boolean {
  let matched = false;
  for (const line of output.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry._SYSTEMD_INVOCATION_ID === invocationId
        || entry.OBJECT_SYSTEMD_INVOCATION_ID === invocationId
        || entry.USER_INVOCATION_ID === invocationId) matched = true;
    } catch {
      return false;
    }
  }
  return matched;
}

export function canonicalJournalJson(output: string): string {
  const entries = output.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const canonical = entries.map((line) => {
    const entry: unknown = JSON.parse(line);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError("Journal JSON entries must be objects");
    }
    return canonicalReleaseJson(entry);
  });
  return canonical.length === 0 ? "" : `${canonical.join("\n")}\n`;
}

export async function runAlertDrill(options: AlertDrillOptions): Promise<PublicDrillReceipt> {
  const root = realpathSync(options.projectRoot);
  const path = safeDatabasePath(root, options.databasePath);
  const now = options.now();
  if (!Number.isFinite(now.getTime())) throw new Error("Alert drill clock is invalid");
  if (options.testRunner !== undefined && process.env.VITEST !== "true") {
    throw new Error("Alert drill test runner is restricted to Vitest");
  }
  const evaluatedCommit = commit(root);
  const runner = options.testRunner;
  const release = runner === undefined
    ? installedRelease(root, evaluatedCommit, now)
    : runner.resolveRelease({ projectRoot: root, evaluatedCommit, now });
  if (release.sourceCommit !== evaluatedCommit
    || !HEX_40.test(release.sourceCommit)
    || !/^[a-f0-9]{32}$/u.test(release.releaseId)
    || ![release.manifestSha256, release.artifactSetSha256, release.cliArtifactSha256]
      .every((value) => HEX_64.test(value))
    || !isAbsolute(release.releasePath) || !isAbsolute(release.cliPath)
    || !isAbsolute(release.nodePath)) {
    throw new Error("Alert drill release binding is invalid");
  }
  const run = runner === undefined
    ? async (command: string, args: readonly string[], commandOptions: DrillCommandOptions) =>
        nativeCommand(command, args, commandOptions)
    : runner.run.bind(runner);
  const before = heartbeatSnapshot(path);
  const rawDrillId = (options.drillId ?? randomUUID)().replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(rawDrillId)) throw new Error("Alert drill ID is invalid");
  const transientUnit = `precos-alert-drill-${rawDrillId.slice(0, 12)}.service`;
  const baseOptions = { cwd: root, env: { ...process.env } };
  const failureCommand = systemdFailureCommand(transientUnit);
  const failure = await run(failureCommand.command, failureCommand.args, baseOptions);
  const showArgs = [
    "--user", "show", transientUnit,
    "--property=Result,ExecMainCode,ExecMainStatus,InvocationID",
  ];
  const shown = await run("systemctl", showArgs, baseOptions);
  const properties = parseProperties(shown.stdout);
  const invocationId = properties.get("InvocationID") ?? "";
  const result = properties.get("Result") ?? "";
  const rawExecMainCode = properties.get("ExecMainCode") ?? "";
  const execMainCode = rawExecMainCode === "2" || rawExecMainCode === "killed"
    ? "killed" : rawExecMainCode;
  const execMainStatus = Number(properties.get("ExecMainStatus"));
  await run("systemctl", ["--user", "reset-failed", transientUnit], baseOptions);
  const journalArgs = ["--user", "-u", transientUnit, "--output=json", "--no-pager", "--all"];
  const journal = await run("journalctl", journalArgs, baseOptions);
  let canonicalJournal = "";
  let journalCanonical = false;
  try {
    canonicalJournal = canonicalJournalJson(journal.stdout);
    journalCanonical = true;
  } catch {
    canonicalJournal = "";
  }
  const journalBytes = Buffer.byteLength(canonicalJournal);
  const journalInvocationMatched = journalCanonical
    && /^[a-f0-9]{32}$/u.test(invocationId)
    && journalMatchesInvocation(canonicalJournal, invocationId);

  const stagingParent = join(root, "var/acceptance");
  mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
  const stagingRoot = mkdtempSync(join(stagingParent, "alert-drill-"));
  let receipt: PublicDrillReceipt;
  try {
    const isolatedDatabasePath = join(stagingRoot, "data", "precos.sqlite");
    const isolatedAlertPath = join(stagingRoot, "var", "log", "alerts.jsonl");
    const isolatedEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PROJECT_ROOT: stagingRoot,
      DATABASE_PATH: isolatedDatabasePath,
      NTFY_TOPIC: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      CODEX_API_KEY: "",
      CODEX_BASE_URL: "",
      LIVE_OPENAI: "0",
    };
    const cliOptions = { cwd: stagingRoot, env: isolatedEnvironment };
    const dbInitArgs = [release.cliPath, "db", "init"];
    const dbInit = await run(release.nodePath, dbInitArgs, cliOptions);
    const heartbeatArgs = [release.cliPath, "heartbeat", "check", "--json"];
    const heartbeat = await run(release.nodePath, heartbeatArgs, cliOptions);
    let heartbeatOutput: Record<string, unknown> = {};
    try {
      heartbeatOutput = JSON.parse(heartbeat.stdout.trim()) as Record<string, unknown>;
    } catch {
      heartbeatOutput = {};
    }
    const heartbeatOutputValid = exactKeys(heartbeatOutput, ["ageMs", "lastSuccessAt", "stale"])
      && heartbeatOutput.stale === true
      && heartbeatOutput.ageMs === null
      && heartbeatOutput.lastSuccessAt === null;
    let isolatedHeartbeatRows = -1;
    let isolatedSchemaMigrationCount = -1;
    let isolatedSchemaVersion = -1;
    if (existsSync(isolatedDatabasePath)) {
      const isolated = new Database(isolatedDatabasePath, { readonly: true, fileMustExist: true });
      try {
        isolatedHeartbeatRows = (isolated.prepare(
          "SELECT COUNT(*) AS count FROM heartbeats",
        ).get() as { count: number }).count;
        const schema = isolated.prepare(`
          SELECT COUNT(*) AS count, COALESCE(MAX(version), 0) AS version
          FROM schema_migrations
        `).get() as { count: number; version: number };
        isolatedSchemaMigrationCount = schema.count;
        isolatedSchemaVersion = schema.version;
      } finally {
        isolated.close();
      }
    }
    let isolatedAlertLine = "";
    let isolatedAlertLineMatched = false;
    let isolatedAlertMode = "";
    if (existsSync(isolatedAlertPath)) {
      isolatedAlertMode = (statSync(isolatedAlertPath).mode & 0o777)
        .toString(8).padStart(4, "0");
      const lines = readFileSync(isolatedAlertPath, "utf8").trimEnd().split("\n");
      if (lines.length === 1) {
        isolatedAlertLine = `${lines[0] ?? ""}\n`;
        try {
          const alert = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
          const details = alert.details as Record<string, unknown> | undefined;
          isolatedAlertLineMatched = alert.severity === "error"
            && alert.title === "Preço collection heartbeat stale"
            && typeof alert.timestamp === "string" && Number.isFinite(Date.parse(alert.timestamp))
            && details?.stale === true && details.ageMs === null
            && details.lastSuccessAt === null;
        } catch {
          isolatedAlertLineMatched = false;
        }
      }
    }
    const after = heartbeatSnapshot(path);
    const sourceHeartbeatsUnchanged = before.count === after.count
      && before.latestId === after.latestId && before.sha256 === after.sha256;
    const expectedSchemaVersion = EXPECTED_SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;
    const passed = failure.exitCode !== 0
      && shown.exitCode === 0 && shown.stderr === ""
      && result === "signal" && execMainCode === "killed" && execMainStatus === 9
      && journal.exitCode === 0 && journal.stderr === "" && journalBytes > 0
      && journalInvocationMatched
      && dbInit.exitCode === 0 && dbInit.stderr === ""
      && heartbeat.exitCode === 0 && heartbeat.stderr === "" && heartbeatOutputValid
      && isolatedAlertMode === "0600" && isolatedAlertLineMatched
      && isolatedHeartbeatRows === 0
      && isolatedSchemaMigrationCount === EXPECTED_SCHEMA_MIGRATIONS.length
      && isolatedSchemaVersion === expectedSchemaVersion
      && sourceHeartbeatsUnchanged;
    receipt = {
      schemaVersion: 1,
      drill: "alert",
      status: passed ? "pass" : "fail",
      observedAt: now.toISOString(),
      evaluatedCommit,
      implementationSha256: implementationSha256(),
      reasonCodes: passed ? [] : ["EVIDENCE_CONTRADICTION"],
      facts: {
        protocolVersion: 2,
        releaseId: release.releaseId,
        releaseManifestSha256: release.manifestSha256,
        releaseArtifactSetSha256: release.artifactSetSha256,
        heartbeatCliArtifactSha256: release.cliArtifactSha256,
        transientUnit,
        systemdRunCommandSha256: commandSha256(failureCommand.command, failureCommand.args),
        systemdRunExitCode: failure.exitCode,
        systemdResult: result,
        execMainCode,
        execMainStatus,
        invocationId,
        journalBytes,
        journalSha256: sha256(canonicalJournal),
        journalInvocationMatched,
        dbInitCommandSha256: commandSha256(release.nodePath, dbInitArgs),
        dbInitExitCode: dbInit.exitCode,
        heartbeatCommandSha256: commandSha256(release.nodePath, heartbeatArgs),
        heartbeatExitCode: heartbeat.exitCode,
        heartbeatStdoutSha256: sha256(heartbeat.stdout),
        heartbeatStale: heartbeatOutput.stale === true,
        heartbeatLastSuccessAt: heartbeatOutput.lastSuccessAt === null
          ? null : String(heartbeatOutput.lastSuccessAt ?? "invalid"),
        isolatedSchemaMigrationCount,
        isolatedSchemaVersion,
        isolatedHeartbeatRows,
        isolatedAlertMode,
        isolatedAlertLineSha256: sha256(isolatedAlertLine),
        isolatedAlertLineMatched,
        sourceHeartbeatRowsBefore: before.count,
        sourceHeartbeatRowsAfter: after.count,
        sourceHeartbeatSnapshotSha256Before: before.sha256,
        sourceHeartbeatSnapshotSha256After: after.sha256,
        sourceHeartbeatsUnchanged,
      },
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
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
