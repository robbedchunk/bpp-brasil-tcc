import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const SHA256 = /^[a-f0-9]{64}$/u;
const INVOCATION_ID = /^[a-f0-9]{32}$/u;
const ARTIFACT_NAME = /^precos-\d{8}T\d{6}-\d+\.sqlite$/u;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const RECEIPT_KEYS = [
  "artifactName",
  "artifactSha256",
  "completedAt",
  "databaseSchemaVersion",
  "fileMode",
  "foreignKeyViolations",
  "integrityCheck",
  "invocationId",
  "outputBytes",
  "quickCheck",
  "schemaMigrationCount",
  "schemaVersion",
  "semanticTableCounts",
  "semanticTableCountsSha256",
  "serviceCgroupSha256",
  "snapshotMethod",
  "sourceDatabaseIdentitySha256",
  "sourceSnapshotFingerprintSha256",
  "systemdUnit",
  "trigger",
] as const;

export const REQUIRED_BACKUP_TABLES = [
  "classifications",
  "cost_ledger",
  "exploration_attempts",
  "exploration_runs",
  "healing_events",
  "heartbeats",
  "observations",
  "retailer_state_events",
  "run_failures",
  "runs",
  "schema_migrations",
] as const;

export interface ScheduledBackupReceipt {
  schemaVersion: 1;
  trigger: "manual" | "systemd";
  systemdUnit: "precos-backup.service" | null;
  invocationId: string | null;
  serviceCgroupSha256: string | null;
  artifactName: string;
  sourceDatabaseIdentitySha256: string;
  snapshotMethod: "sqlite-online-backup-read-transaction";
  sourceSnapshotFingerprintSha256: string;
  semanticTableCounts: Record<string, number>;
  semanticTableCountsSha256: string;
  artifactSha256: string;
  outputBytes: number;
  completedAt: string;
  databaseSchemaVersion: number | null;
  schemaMigrationCount: number;
  integrityCheck: "ok";
  quickCheck: "ok";
  foreignKeyViolations: 0;
  fileMode: "0600";
}

interface DatabaseSnapshotFacts {
  sourceSnapshotFingerprintSha256: string;
  semanticTableCounts: Record<string, number>;
  semanticTableCountsSha256: string;
  artifactSha256: string;
  outputBytes: number;
  databaseSchemaVersion: number | null;
  schemaMigrationCount: number;
  integrityCheck: string;
  quickCheck: string;
  foreignKeyViolations: number;
  fileMode: string;
}

type SemanticSnapshotFacts = Omit<DatabaseSnapshotFacts,
  "artifactSha256" | "outputBytes" | "fileMode">;

export interface ScheduledBackupPairValidation {
  valid: boolean;
  receipt: ScheduledBackupReceipt | null;
  artifactPath: string | null;
  reason: string | null;
}

export type ValidScheduledBackupPair = ScheduledBackupPairValidation & {
  valid: true;
  receipt: ScheduledBackupReceipt;
  artifactPath: string;
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function backupServiceCgroup(cgroupText: string): string | null {
  for (const line of cgroupText.trim().split("\n")) {
    const fields = line.split(":");
    const path = fields.slice(2).join(":");
    const components = path.split("/").filter((component) => component !== "");
    if (components.at(-1) === "precos-backup.service") return path;
  }
  return null;
}

function normalizedRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    Buffer.isBuffer(value) ? { base64: value.toString("base64") } : value,
  ]));
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
    if (!TABLE_NAME.test(name)) throw new Error(`unsafe table name in backup: ${name}`);
    digest.update(`\0${name}\0`);
    const rows = database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate() as unknown as
      Iterable<Record<string, unknown>>;
    for (const row of rows) {
      digest.update(JSON.stringify(normalizedRow(row)));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}

function tableCounts(database: Database.Database): Record<string, number> {
  const result: Record<string, number> = {};
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    if (!TABLE_NAME.test(name)) throw new Error(`unsafe table name in backup: ${name}`);
    const row = database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number };
    result[name] = row.count;
  }
  return result;
}

function firstPragmaValue(rows: Array<Record<string, unknown>>): string {
  return String(Object.values(rows[0] ?? {})[0] ?? "invalid");
}

function databaseSemanticFacts(database: Database.Database): SemanticSnapshotFacts {
  let databaseSchemaVersion: number | null = null;
  let schemaMigrationCount = 0;
  const integrityCheck = firstPragmaValue(
    database.pragma("integrity_check") as Array<Record<string, unknown>>,
  );
  const quickCheck = firstPragmaValue(
    database.pragma("quick_check") as Array<Record<string, unknown>>,
  );
  const foreignKeyViolations = (database.pragma("foreign_key_check") as unknown[]).length;
  const counts = tableCounts(database);
  const fingerprint = semanticFingerprint(database);
  if (counts.schema_migrations !== undefined) {
    const row = database.prepare(`
      SELECT COUNT(*) AS count, MAX(version) AS version FROM schema_migrations
    `).get() as { count: number; version: number | null };
    schemaMigrationCount = row.count;
    databaseSchemaVersion = row.version;
  }
  const countsJson = JSON.stringify(counts);
  return {
    sourceSnapshotFingerprintSha256: fingerprint,
    semanticTableCounts: counts,
    semanticTableCountsSha256: sha256(countsJson),
    databaseSchemaVersion,
    schemaMigrationCount,
    integrityCheck,
    quickCheck,
    foreignKeyViolations,
  };
}

function snapshotFacts(artifactPath: string): DatabaseSnapshotFacts {
  const metadataBefore = statSync(artifactPath);
  const database = new Database(artifactPath, { readonly: true, fileMustExist: true });
  let semanticFacts: SemanticSnapshotFacts;
  try {
    semanticFacts = databaseSemanticFacts(database);
  } finally {
    database.close();
  }
  const metadataAfter = statSync(artifactPath);
  if (metadataBefore.dev !== metadataAfter.dev || metadataBefore.ino !== metadataAfter.ino
    || metadataBefore.size !== metadataAfter.size || metadataBefore.mtimeMs !== metadataAfter.mtimeMs) {
    throw new Error("backup artifact changed while evidence was computed");
  }
  return {
    ...semanticFacts,
    artifactSha256: sha256(readFileSync(artifactPath)),
    outputBytes: metadataAfter.size,
    fileMode: (metadataAfter.mode & 0o777).toString(8).padStart(4, "0"),
  };
}

export function validateScheduledBackupReceipt(input: unknown): ScheduledBackupReceipt {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Scheduled backup receipt must be an object");
  }
  const value = input as Record<string, unknown>;
  const counts = value.semanticTableCounts;
  if (!exactKeys(value, RECEIPT_KEYS)
    || value.schemaVersion !== 1
    || (value.trigger !== "manual" && value.trigger !== "systemd")
    || (value.systemdUnit !== null && value.systemdUnit !== "precos-backup.service")
    || (value.invocationId !== null
      && (typeof value.invocationId !== "string" || !INVOCATION_ID.test(value.invocationId)))
    || (value.serviceCgroupSha256 !== null
      && (typeof value.serviceCgroupSha256 !== "string" || !SHA256.test(value.serviceCgroupSha256)))
    || (value.trigger === "systemd"
      && (value.systemdUnit !== "precos-backup.service" || typeof value.invocationId !== "string"
        || typeof value.serviceCgroupSha256 !== "string"))
    || (value.trigger === "manual"
      && (value.systemdUnit !== null || value.invocationId !== null || value.serviceCgroupSha256 !== null))
    || typeof value.artifactName !== "string" || !ARTIFACT_NAME.test(value.artifactName)
    || typeof value.sourceDatabaseIdentitySha256 !== "string" || !SHA256.test(value.sourceDatabaseIdentitySha256)
    || value.snapshotMethod !== "sqlite-online-backup-read-transaction"
    || typeof value.sourceSnapshotFingerprintSha256 !== "string" || !SHA256.test(value.sourceSnapshotFingerprintSha256)
    || typeof counts !== "object" || counts === null || Array.isArray(counts)
    || typeof value.semanticTableCountsSha256 !== "string" || !SHA256.test(value.semanticTableCountsSha256)
    || value.semanticTableCountsSha256 !== sha256(JSON.stringify(counts))
    || typeof value.artifactSha256 !== "string" || !SHA256.test(value.artifactSha256)
    || !Number.isSafeInteger(value.outputBytes) || Number(value.outputBytes) <= 0
    || typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))
    || new Date(Date.parse(value.completedAt)).toISOString() !== value.completedAt
    || (value.databaseSchemaVersion !== null
      && (!Number.isSafeInteger(value.databaseSchemaVersion) || Number(value.databaseSchemaVersion) < 1))
    || !Number.isSafeInteger(value.schemaMigrationCount) || Number(value.schemaMigrationCount) < 0
    || value.integrityCheck !== "ok" || value.quickCheck !== "ok"
    || value.foreignKeyViolations !== 0 || value.fileMode !== "0600") {
    throw new TypeError("Scheduled backup receipt has invalid or contradictory fields");
  }
  for (const [name, count] of Object.entries(counts as Record<string, unknown>)) {
    if (!TABLE_NAME.test(name) || !Number.isSafeInteger(count) || Number(count) < 0) {
      throw new TypeError("Scheduled backup receipt contains invalid semantic table counts");
    }
  }
  return input as ScheduledBackupReceipt;
}

function buildReceipt(input: {
  sourceDatabasePath: string;
  artifactName: string;
  invocationId: string | null;
  serviceCgroupSha256: string | null;
  sourceFacts: SemanticSnapshotFacts;
  artifactFacts: DatabaseSnapshotFacts;
  completedAt: Date;
}): ScheduledBackupReceipt {
  const receipt: ScheduledBackupReceipt = {
    schemaVersion: 1,
    trigger: input.invocationId === null ? "manual" : "systemd",
    systemdUnit: input.invocationId === null ? null : "precos-backup.service",
    invocationId: input.invocationId,
    serviceCgroupSha256: input.serviceCgroupSha256,
    artifactName: input.artifactName,
    sourceDatabaseIdentitySha256: sha256(input.sourceDatabasePath),
    snapshotMethod: "sqlite-online-backup-read-transaction",
    sourceSnapshotFingerprintSha256: input.sourceFacts.sourceSnapshotFingerprintSha256,
    semanticTableCounts: input.sourceFacts.semanticTableCounts,
    semanticTableCountsSha256: input.sourceFacts.semanticTableCountsSha256,
    artifactSha256: input.artifactFacts.artifactSha256,
    outputBytes: input.artifactFacts.outputBytes,
    completedAt: input.completedAt.toISOString(),
    databaseSchemaVersion: input.sourceFacts.databaseSchemaVersion,
    schemaMigrationCount: input.sourceFacts.schemaMigrationCount,
    integrityCheck: input.sourceFacts.integrityCheck as "ok",
    quickCheck: input.sourceFacts.quickCheck as "ok",
    foreignKeyViolations: input.sourceFacts.foreignKeyViolations as 0,
    fileMode: input.artifactFacts.fileMode as "0600",
  };
  return validateScheduledBackupReceipt(receipt);
}

function writeReceiptAtomic(receipt: ScheduledBackupReceipt, destination: string): void {
  const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${process.pid}`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function matchingSemanticSnapshots(
  source: SemanticSnapshotFacts,
  artifact: DatabaseSnapshotFacts,
): boolean {
  return source.sourceSnapshotFingerprintSha256 === artifact.sourceSnapshotFingerprintSha256
    && JSON.stringify(source.semanticTableCounts) === JSON.stringify(artifact.semanticTableCounts)
    && source.semanticTableCountsSha256 === artifact.semanticTableCountsSha256
    && source.databaseSchemaVersion === artifact.databaseSchemaVersion
    && source.schemaMigrationCount === artifact.schemaMigrationCount
    && source.integrityCheck === artifact.integrityCheck
    && source.quickCheck === artifact.quickCheck
    && source.foreignKeyViolations === artifact.foreignKeyViolations;
}

export async function createScheduledBackupBundle(input: {
  sourceDatabasePath: string;
  artifactPath: string;
  receiptPath: string;
  invocationId?: string | null;
  completedAt?: () => Date;
  cgroupText?: string;
  afterBackup?: (context: {
    sourceDatabasePath: string;
    temporaryArtifactPath: string;
  }) => void | Promise<void>;
}): Promise<ScheduledBackupReceipt> {
  const invocationId = input.invocationId === undefined || input.invocationId === null
    || input.invocationId === ""
    ? null
    : input.invocationId.toLowerCase();
  if (invocationId !== null && !INVOCATION_ID.test(invocationId)) {
    throw new Error("INVOCATION_ID must be 32 hexadecimal characters");
  }
  const serviceCgroup = invocationId === null
    ? null
    : backupServiceCgroup(input.cgroupText ?? readFileSync("/proc/self/cgroup", "utf8"));
  if (invocationId !== null && serviceCgroup === null) {
    throw new Error("INVOCATION_ID is not running in the exact precos-backup.service cgroup");
  }
  const sourceDatabasePath = realpathSync(input.sourceDatabasePath);
  const artifactPath = resolve(input.artifactPath);
  const receiptPath = resolve(input.receiptPath);
  const artifactName = basename(artifactPath);
  const backupDirectory = realpathSync(dirname(artifactPath));
  if (!ARTIFACT_NAME.test(artifactName)
    || dirname(artifactPath) !== backupDirectory
    || receiptPath !== `${artifactPath}.receipt.json`) {
    throw new Error("artifact and receipt must be exact companions in the backup directory");
  }
  if (existsSync(artifactPath) || existsSync(receiptPath)) {
    throw new Error("scheduled backup artifact or receipt already exists");
  }
  const temporaryArtifactPath = join(
    backupDirectory,
    `.${artifactName}.part-${process.pid}-${randomUUID()}`,
  );
  const source = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
  let transactionOpen = false;
  let sourceFacts: SemanticSnapshotFacts;
  let artifactFacts: DatabaseSnapshotFacts;
  let artifactPublished = false;
  try {
    source.exec("BEGIN");
    transactionOpen = true;
    sourceFacts = databaseSemanticFacts(source);
    if (sourceFacts.integrityCheck !== "ok" || sourceFacts.quickCheck !== "ok"
      || sourceFacts.foreignKeyViolations !== 0) {
      throw new Error("source database failed integrity or foreign-key checks");
    }
    await source.backup(temporaryArtifactPath);
    chmodSync(temporaryArtifactPath, 0o600);
    await input.afterBackup?.({ sourceDatabasePath, temporaryArtifactPath });
    artifactFacts = snapshotFacts(temporaryArtifactPath);
    if (!matchingSemanticSnapshots(sourceFacts, artifactFacts)) {
      throw new Error("backup artifact does not match the coherently captured source snapshot");
    }
    source.exec("COMMIT");
    transactionOpen = false;
    source.close();

    const descriptor = openSync(temporaryArtifactPath, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryArtifactPath, artifactPath);
    artifactPublished = true;
    const receipt = buildReceipt({
      sourceDatabasePath,
      artifactName,
      invocationId,
      serviceCgroupSha256: serviceCgroup === null ? null : sha256(serviceCgroup),
      sourceFacts,
      artifactFacts,
      completedAt: input.completedAt?.() ?? new Date(),
    });
    writeReceiptAtomic(receipt, receiptPath);
    return receipt;
  } finally {
    if (transactionOpen) {
      try {
        source.exec("ROLLBACK");
      } catch {
        // Cleanup preserves the original error.
      }
    }
    if (source.open) source.close();
    for (const path of [
      temporaryArtifactPath,
      `${temporaryArtifactPath}-wal`,
      `${temporaryArtifactPath}-shm`,
    ]) rmSync(path, { force: true });
    if (artifactPublished && !existsSync(receiptPath)) {
      for (const path of [artifactPath, `${artifactPath}-wal`, `${artifactPath}-shm`]) {
        rmSync(path, { force: true });
      }
    }
  }
}

export function validateScheduledBackupPair(input: {
  receiptPath: string;
  backupDirectory: string;
  sourceDatabasePath: string;
}): ScheduledBackupPairValidation {
  try {
    const backupDirectory = realpathSync(input.backupDirectory);
    const receiptPath = resolve(input.receiptPath);
    const receiptMetadata = lstatSync(receiptPath);
    if (!receiptMetadata.isFile() || receiptMetadata.isSymbolicLink()
      || (receiptMetadata.mode & 0o777) !== 0o600
      || dirname(realpathSync(receiptPath)) !== backupDirectory) {
      throw new Error("receipt is not a private regular file in the backup directory");
    }
    const receipt = validateScheduledBackupReceipt(JSON.parse(readFileSync(receiptPath, "utf8")));
    if (basename(receiptPath) !== `${receipt.artifactName}.receipt.json`) {
      throw new Error("receipt filename does not bind its artifact");
    }
    const artifactPath = join(backupDirectory, receipt.artifactName);
    const artifactMetadata = lstatSync(artifactPath);
    if (!artifactMetadata.isFile() || artifactMetadata.isSymbolicLink()
      || dirname(realpathSync(artifactPath)) !== backupDirectory) {
      throw new Error("artifact is not a regular file in the backup directory");
    }
    const facts = snapshotFacts(artifactPath);
    const expectedIdentity = sha256(realpathSync(input.sourceDatabasePath));
    if (receipt.sourceDatabaseIdentitySha256 !== expectedIdentity
      || facts.sourceSnapshotFingerprintSha256 !== receipt.sourceSnapshotFingerprintSha256
      || JSON.stringify(facts.semanticTableCounts) !== JSON.stringify(receipt.semanticTableCounts)
      || facts.semanticTableCountsSha256 !== receipt.semanticTableCountsSha256
      || facts.artifactSha256 !== receipt.artifactSha256
      || facts.outputBytes !== receipt.outputBytes
      || facts.databaseSchemaVersion !== receipt.databaseSchemaVersion
      || facts.schemaMigrationCount !== receipt.schemaMigrationCount
      || facts.integrityCheck !== receipt.integrityCheck
      || facts.quickCheck !== receipt.quickCheck
      || facts.foreignKeyViolations !== receipt.foreignKeyViolations
      || facts.fileMode !== receipt.fileMode) {
      throw new Error("receipt facts do not match the exact backup artifact or source database");
    }
    return { valid: true, receipt, artifactPath, reason: null };
  } catch (error) {
    return {
      valid: false,
      receipt: null,
      artifactPath: null,
      reason: error instanceof Error ? error.message : "scheduled backup validation failed",
    };
  }
}

export function scheduledBackupPairMatchesService(
  pair: ScheduledBackupPairValidation,
  service: {
    invocationId: string | null | undefined;
    startedAt: number;
    finishedAt: number;
    currentWindowStart: number;
    now: number;
  },
): pair is ValidScheduledBackupPair {
  if (!pair.valid || pair.receipt === null || pair.artifactPath === null
    || pair.receipt.trigger !== "systemd"
    || pair.receipt.databaseSchemaVersion === null
    || pair.receipt.schemaMigrationCount < 1
    || typeof service.invocationId !== "string" || !INVOCATION_ID.test(service.invocationId)
    || pair.receipt.invocationId !== service.invocationId
    || !REQUIRED_BACKUP_TABLES.every((table) => pair.receipt?.semanticTableCounts[table] !== undefined)) {
    return false;
  }
  const completedAt = Date.parse(pair.receipt.completedAt);
  return Number.isFinite(completedAt)
    && Number.isFinite(service.startedAt)
    && completedAt >= service.currentWindowStart
    && completedAt <= service.now
    && completedAt >= service.startedAt - 1_000
    && (!Number.isFinite(service.finishedAt) || completedAt <= service.finishedAt + 1_000);
}

function parseCliArguments(args: string[]): {
  sourceDatabasePath: string;
  artifactPath: string;
  receiptPath: string;
  invocationId: string | null;
} {
  if (args[0] !== "create") {
    throw new Error("usage: scheduled-backup create --source PATH --artifact PATH --receipt PATH [--invocation-id ID]");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("scheduled backup receipt arguments must be name/value pairs");
    }
    if (values.has(name)) throw new Error(`duplicate scheduled backup argument: ${name}`);
    values.set(name, value);
  }
  const sourceDatabasePath = values.get("--source");
  const artifactPath = values.get("--artifact");
  const receiptPath = values.get("--receipt");
  if (sourceDatabasePath === undefined || artifactPath === undefined || receiptPath === undefined
    || [...values.keys()].some((name) => !["--source", "--artifact", "--receipt", "--invocation-id"].includes(name))) {
    throw new Error("scheduled backup receipt arguments are incomplete or unknown");
  }
  return {
    sourceDatabasePath,
    artifactPath,
    receiptPath,
    invocationId: values.get("--invocation-id") || null,
  };
}

function invokedAsMain(invokedPath: string | undefined): boolean {
  if (invokedPath === undefined) return false;
  try {
    return realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain(process.argv[1])) {
  const options = parseCliArguments(process.argv.slice(2));
  await createScheduledBackupBundle(options);
}
