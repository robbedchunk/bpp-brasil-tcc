import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";

import {
  CLASSIFICATION_REVIEW_SIZE,
  readClassificationReviewResult,
} from "../classify/review.js";
import { EXPECTED_SCHEMA_MIGRATIONS } from "../db/database.js";
import { databaseSourceSnapshotSha256 } from "../index/export.js";
import {
  auditPublication,
  validateFreshCloneReceipt,
  type PublicationAuditReport,
} from "../publication/audit.js";
import {
  loadRetailerConfigs,
  RetailerConfigSchema,
  type RetailerConfig,
} from "../retailers/config.js";
import { parseStrategy } from "../strategies/schema.js";
import {
  readTrustedValidatorArtifactSha256,
  readValidationVerificationPublicKey,
  StrategyValidationEvidenceSchema,
  strategyEvidenceSha256,
  validateStrategyEvidence,
  validationReceiptSha256,
} from "../strategies/validation-evidence.js";
import {
  canonicalJournalJson,
  validatePublicDrillReceipt,
  type PublicDrillReceipt,
} from "./acceptance-drills.js";
import {
  assertHealingSabotageReceiptFresh,
  validateHealingSabotageEvidence,
  type HealingSabotageDrillReceipt,
} from "./healing-drill.js";
import {
  isAcceptanceEvidencePath,
  releaseSourceMatchesEvaluatedCommit,
  resolveAcceptanceEvaluatedCommit,
} from "./evidence-cut.js";
import {
  REQUIRED_BACKUP_TABLES,
  scheduledBackupPairMatchesService,
  validateScheduledBackupPair,
  validateScheduledBackupReceipt,
  type ScheduledBackupPairValidation,
  type ScheduledBackupReceipt,
} from "./scheduled-backup.js";
import {
  validateFrozenRelease,
  type ReleaseManifest,
  type ValidateReleaseOptions,
} from "./release-manifest.js";

export {
  releaseSourceMatchesEvaluatedCommit,
  resolveAcceptanceEvaluatedCommit,
} from "./evidence-cut.js";

export type AcceptanceStatus = "pass" | "pending" | "fail";
export type MilestoneId = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";
export type PendingGateKind = "time" | "credential" | "site" | "authority";

export interface AcceptanceEvidence {
  id: string;
  kind: "command" | "database-query" | "file" | "service" | "receipt";
  source: string;
  observedAt: string;
  sha256?: string;
  facts: Record<string, string | number | boolean | null>;
}

export interface AcceptanceCriterion {
  id: string;
  status: AcceptanceStatus;
  summary: string;
  reasonCodes: string[];
  evidenceIds: string[];
}

export interface PendingGate {
  criterionId: string;
  kind: PendingGateKind;
  reasonCode: string;
  since: string | null;
  nextAction: string;
  recheckCommand: string;
  evidenceIds: string[];
}

export interface MilestoneAcceptance {
  status: AcceptanceStatus;
  criteria: AcceptanceCriterion[];
}

export interface AcceptanceReport {
  schemaVersion: 1;
  generatedAt: string;
  timezone: "America/Sao_Paulo";
  evaluatedCommit: string;
  databaseSha256: string;
  overallStatus: AcceptanceStatus;
  milestones: Record<MilestoneId, MilestoneAcceptance>;
  publication: PublicationAuditReport;
  pendingGates: PendingGate[];
  evidence: AcceptanceEvidence[];
}

export interface CommandEvidence {
  id: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  outputSha256: string;
  facts: Record<string, string | number | boolean | null>;
}

export interface ServiceState {
  unit: string;
  enabled: boolean;
  active: boolean;
  result: string | null;
  invocationId: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastTriggerAt?: string | null;
}

export interface ServiceStateReader {
  read(units: string[]): Promise<ServiceState[]>;
  readUserLingerEnabled?(): Promise<boolean>;
}

export interface ClassificationAutomationState {
  dailyActive: boolean;
  dailyResult: string | null;
  dailyStartedAt: string | null;
  classificationActive: boolean;
  classificationResult: string | null;
  classificationStartedAt: string | null;
  currentDailyStart: Date;
}

export function classificationAutomationIsCurrent(input: ClassificationAutomationState): {
  current: boolean;
  dailyRunObserved: boolean;
} {
  const dailyStartedAt = Date.parse(input.dailyStartedAt ?? "");
  const classificationStartedAt = Date.parse(input.classificationStartedAt ?? "");
  const dailyRunObserved = input.dailyResult !== null && Number.isFinite(dailyStartedAt)
    && dailyStartedAt >= input.currentDailyStart.getTime();
  return {
    dailyRunObserved,
    current: !dailyRunObserved
      || input.dailyActive
      || input.classificationActive
      || (input.classificationResult === "success" && Number.isFinite(classificationStartedAt)
        && classificationStartedAt >= dailyStartedAt),
  };
}

export interface AcceptanceOptions {
  projectRoot: string;
  databasePath: string;
  now: () => Date;
  runCommand: (id: string, command: string, args: string[]) => Promise<CommandEvidence>;
  serviceReader: ServiceStateReader;
  credentialConfigured?: boolean;
  explorerCredentialConfigured?: boolean;
  spendAuthorized?: boolean;
  siteValidated?: boolean;
}

export interface PublicDrillReceiptShape extends PublicDrillReceipt {}

export interface SnapshotVerification {
  status: "pass" | "fail";
  evaluatedCommit: string;
  headCommit: string;
  changedPaths: string[];
  reasonCodes: string[];
}

export interface CriterionEvaluation {
  criterion: AcceptanceCriterion;
  gates: PendingGate[];
  evidence: AcceptanceEvidence[];
}

const MILESTONES: MilestoneId[] = ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"];
const TIMER_UNITS = [
  "precos-daily.timer",
  "precos-healing.timer",
  "precos-weekly-discovery.timer",
  "precos-weekly-index.timer",
  "precos-heartbeat.timer",
  "precos-backup.timer",
] as const;
const SERVICE_UNITS = TIMER_UNITS.map((unit) => unit.replace(/\.timer$/u, ".service"));
const CLASSIFICATION_SERVICE_UNIT = "precos-classification.service";
const ALL_SYSTEMD_UNITS = [...TIMER_UNITS, ...SERVICE_UNITS, CLASSIFICATION_SERVICE_UNIT].sort();
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const REASON_CODES = new Set([
  "TIME_WINDOW_NOT_ELAPSED", "SCHEDULED_RUN_NOT_YET_DUE", "CREDENTIAL_NOT_CONFIGURED",
  "LIVE_SPEND_NOT_AUTHORIZED", "SITE_VALIDATION_PENDING", "OFFICIAL_OVERLAP_NOT_AVAILABLE",
  "AUTHORITY_APPROVAL_REQUIRED", "REQUIRED_ARTIFACT_MISSING", "OFFLINE_CHECK_FAILED",
  "DATABASE_INTEGRITY_FAILED", "SECRET_OR_PRIVATE_ARTIFACT", "MISSED_SCHEDULED_RUN",
  "EVIDENCE_CONTRADICTION", "UNSAFE_CONFIGURATION", "REVIEW_FINDING_OPEN",
]);

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function coherentDatabaseHash(database: Database.Database): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "acceptance-database-hash-"));
  const path = join(root, "snapshot.sqlite");
  try {
    await database.backup(path);
    return hash(readFileSync(path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function gitSucceeds(root: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface SystemdInstallationState {
  valid: boolean;
  scheduleActivatedAt: Date | null;
  deployedAt: Date | null;
  sourceCommit: string | null;
  releaseId: string | null;
  releasePath: string | null;
  releaseManifestSha256: string | null;
  /** Compatibility alias for scheduleActivatedAt. */
  installedAt: Date | null;
  unitSetSha256: string | null;
}

const invalidSystemdInstallation = (): SystemdInstallationState => ({
  valid: false,
  scheduleActivatedAt: null,
  deployedAt: null,
  sourceCommit: null,
  releaseId: null,
  releasePath: null,
  releaseManifestSha256: null,
  installedAt: null,
  unitSetSha256: null,
});

export function readSystemdInstallationState(
  root: string,
  now: Date,
  installedUnitDirectory = resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user"),
  releaseValidator: (options: ValidateReleaseOptions) => ReleaseManifest = validateFrozenRelease,
): SystemdInstallationState {
  const path = join(root, "var/operations/systemd-install.json");
  const parsed = readJson(path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || !exactObjectKeys(parsed as Record<string, unknown>, [
      "deployedAt", "releaseId", "releaseManifestSha256", "releasePath",
      "scheduleActivatedAt", "schemaVersion", "sourceCommit", "unitSetSha256", "units",
    ])) {
    return invalidSystemdInstallation();
  }
  const receipt = parsed as Record<string, unknown>;
  const scheduleActivatedAtMs = typeof receipt.scheduleActivatedAt === "string"
    ? Date.parse(receipt.scheduleActivatedAt) : Number.NaN;
  const deployedAtMs = typeof receipt.deployedAt === "string" ? Date.parse(receipt.deployedAt) : Number.NaN;
  if (receipt.schemaVersion !== 2
    || !Number.isFinite(scheduleActivatedAtMs) || scheduleActivatedAtMs > now.getTime()
    || new Date(scheduleActivatedAtMs).toISOString() !== receipt.scheduleActivatedAt
    || !Number.isFinite(deployedAtMs) || deployedAtMs > now.getTime()
    || new Date(deployedAtMs).toISOString() !== receipt.deployedAt
    || typeof receipt.sourceCommit !== "string" || !COMMIT.test(receipt.sourceCommit)
    || typeof receipt.releaseId !== "string" || !/^[a-f0-9]{32}$/u.test(receipt.releaseId)
    || typeof receipt.releasePath !== "string" || !isAbsolute(receipt.releasePath)
    || resolve(receipt.releasePath) !== receipt.releasePath
    || typeof receipt.releaseManifestSha256 !== "string" || !SHA256.test(receipt.releaseManifestSha256)
    || typeof receipt.unitSetSha256 !== "string" || !SHA256.test(receipt.unitSetSha256)
    || !Array.isArray(receipt.units) || receipt.units.length !== ALL_SYSTEMD_UNITS.length
    || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
    || (statSync(path).mode & 0o777) !== 0o600) {
    return invalidSystemdInstallation();
  }
  let release: ReleaseManifest;
  try {
    release = releaseValidator({
      releasePath: receipt.releasePath,
      publicKeyPath: join(root, "ops/validation-attestation-public.pem"),
      expectedSourceCommit: receipt.sourceCommit,
      expectedReleaseId: receipt.releaseId,
      expectedSourceRoot: root,
    });
    const manifestPath = join(receipt.releasePath, "release-manifest.json");
    if (release.deployedAt !== receipt.deployedAt
      || hash(readFileSync(manifestPath)) !== receipt.releaseManifestSha256) {
      return invalidSystemdInstallation();
    }
  } catch {
    return invalidSystemdInstallation();
  }
  const names = new Set<string>();
  const units: Array<{ name: string; sha256: string }> = [];
  for (const value of receipt.units) {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !exactObjectKeys(value as Record<string, unknown>, ["name", "sha256"])) {
      return invalidSystemdInstallation();
    }
    const unit = value as Record<string, unknown>;
    if (typeof unit.name !== "string" || !ALL_SYSTEMD_UNITS.includes(unit.name)
      || names.has(unit.name) || typeof unit.sha256 !== "string" || !SHA256.test(unit.sha256)) {
      return invalidSystemdInstallation();
    }
    const installedPath = join(installedUnitDirectory, unit.name);
    if (!existsSync(installedPath) || hash(readFileSync(installedPath)) !== unit.sha256) {
      return invalidSystemdInstallation();
    }
    names.add(unit.name);
    units.push({ name: unit.name, sha256: unit.sha256 });
  }
  units.sort((left, right) => left.name.localeCompare(right.name));
  const computedSetHash = hash(units.map((unit) => `${unit.name}\0${unit.sha256}\n`).join(""));
  if (computedSetHash !== receipt.unitSetSha256) {
    return invalidSystemdInstallation();
  }
  return {
    valid: true,
    scheduleActivatedAt: new Date(scheduleActivatedAtMs),
    deployedAt: new Date(deployedAtMs),
    sourceCommit: receipt.sourceCommit,
    releaseId: receipt.releaseId,
    releasePath: receipt.releasePath,
    releaseManifestSha256: receipt.releaseManifestSha256,
    installedAt: new Date(scheduleActivatedAtMs),
    unitSetSha256: receipt.unitSetSha256,
  };
}

function evidence(
  id: string,
  kind: AcceptanceEvidence["kind"],
  source: string,
  observedAt: string,
  facts: AcceptanceEvidence["facts"],
  sha256?: string,
): AcceptanceEvidence {
  return { id, kind, source, observedAt, ...(sha256 === undefined ? {} : { sha256 }), facts };
}

function criterion(
  id: string,
  status: AcceptanceStatus,
  summary: string,
  reasonCodes: string[],
  evidenceIds: string[],
): AcceptanceCriterion {
  if (status === "pass" && evidenceIds.length === 0) {
    throw new Error(`Passing acceptance criterion ${id} has no evidence`);
  }
  return { id, status, summary, reasonCodes: [...reasonCodes].sort(), evidenceIds: [...evidenceIds].sort() };
}

function gate(
  criterionId: string,
  kind: PendingGateKind,
  reasonCode: string,
  since: string | null,
  nextAction: string,
  recheckCommand: string,
  evidenceIds: string[],
): PendingGate {
  return { criterionId, kind, reasonCode, since, nextAction, recheckCommand, evidenceIds: [...evidenceIds].sort() };
}

export function aggregateAcceptanceStatus(statuses: AcceptanceStatus[]): AcceptanceStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("pending")) return "pending";
  return "pass";
}

export function acceptanceExitCode(status: AcceptanceStatus, requireComplete: boolean): number {
  if (status === "fail") return 1;
  if (status === "pending" && requireComplete) return 3;
  return 0;
}

interface M2Row {
  heartbeat_id: string;
  scheduled_for: string;
  completed_at: string;
  heartbeat_trigger: string | null;
  timer_unit: string | null;
  service_unit: string | null;
  provenance_version: number | null;
  invocation_id: string | null;
  cgroup_sha256: string | null;
  release_id: string | null;
  timer_last_trigger_at: string | null;
  service_started_at: string | null;
  timer_causality_sha256: string | null;
  run_id: string;
  retailer_id: string;
  collection_day: string;
  status: string;
  run_started_at: string;
  run_finished_at: string | null;
  error_category: string | null;
  error_message: string | null;
  latest_observation_at: string | null;
  attempted: number;
  ok: number;
  failed: number;
  validation_sample_size: number;
  validation_successes: number;
  validation_rate: number | null;
  active_products: number;
  observation_rows: number;
  bound_observation_rows: number;
}

const M2_QUERY = `
WITH active_product_counts AS (
  SELECT product.retailer_id, COUNT(*) AS active_products
  FROM products AS product
  JOIN retailers AS retailer ON retailer.id = product.retailer_id AND retailer.active = 1
  WHERE product.active = 1 AND product.in_scope = 1
  GROUP BY product.retailer_id
), heartbeat_run_ids AS (
  SELECT
    heartbeat.id AS heartbeat_id,
    heartbeat.scheduled_for,
    heartbeat.completed_at,
    json_extract(heartbeat.details_json, '$.trigger') AS heartbeat_trigger,
    json_extract(heartbeat.details_json, '$.timerUnit') AS timer_unit,
    json_extract(heartbeat.details_json, '$.serviceUnit') AS service_unit,
    json_extract(heartbeat.details_json, '$.provenanceVersion') AS provenance_version,
    json_extract(heartbeat.details_json, '$.invocationId') AS invocation_id,
    json_extract(heartbeat.details_json, '$.cgroupSha256') AS cgroup_sha256,
    json_extract(heartbeat.details_json, '$.releaseId') AS release_id,
    json_extract(heartbeat.details_json, '$.timerLastTriggerAt') AS timer_last_trigger_at,
    json_extract(heartbeat.details_json, '$.serviceStartedAt') AS service_started_at,
    json_extract(heartbeat.details_json, '$.timerCausalitySha256') AS timer_causality_sha256,
    run_id.value AS run_id
  FROM heartbeats AS heartbeat,
       json_each(heartbeat.details_json, '$.runIds') AS run_id
  WHERE heartbeat.pipeline = 'collect'
    AND heartbeat.status = 'completed'
    AND json_valid(heartbeat.details_json)
    AND json_type(heartbeat.details_json, '$.runIds') = 'array'
    AND COALESCE(json_array_length(heartbeat.details_json, '$.monitorFailedRunIds'), 0) = 0
    AND COALESCE(json_array_length(heartbeat.details_json, '$.retailerFailures'), 0) = 0
)
SELECT
  linked.heartbeat_id,
  linked.scheduled_for,
  linked.completed_at,
  linked.heartbeat_trigger,
  linked.timer_unit,
  linked.service_unit,
  linked.provenance_version,
  linked.invocation_id,
  linked.cgroup_sha256,
  linked.release_id,
  linked.timer_last_trigger_at,
  linked.service_started_at,
  linked.timer_causality_sha256,
  run.id AS run_id,
  run.retailer_id,
  run.collection_day,
  run.status,
  run.started_at AS run_started_at,
  run.finished_at AS run_finished_at,
  run.error_category,
  run.error_message,
  run.attempted,
  run.ok,
  run.failed,
  strategy.validation_sample_size,
  strategy.validation_successes,
  strategy.validation_rate,
  products.active_products,
  COUNT(observation.id) AS observation_rows,
  SUM(CASE WHEN observation.id IS NOT NULL
    AND observation.strategy_id = run.strategy_id
    AND observation.strategy_version = run.strategy_version
    AND observation.collection_day = run.collection_day
    AND observed_product.retailer_id = run.retailer_id
    THEN 1 ELSE 0 END) AS bound_observation_rows,
  MAX(observation.observed_at) AS latest_observation_at
FROM heartbeat_run_ids AS linked
JOIN runs AS run ON run.id = linked.run_id
JOIN strategies AS strategy ON strategy.id = run.strategy_id
  AND strategy.retailer_id = run.retailer_id
  AND strategy.purpose = 'extraction'
  AND strategy.version = run.strategy_version
JOIN active_product_counts AS products ON products.retailer_id = run.retailer_id
LEFT JOIN observations AS observation ON observation.run_id = run.id
LEFT JOIN products AS observed_product ON observed_product.id = observation.product_id
WHERE run.stage = 'collect'
  AND run.status IN ('completed', 'partial')
GROUP BY linked.heartbeat_id, run.id, strategy.id, products.active_products
ORDER BY run.collection_day, run.retailer_id, run.started_at, run.id`;

function validTimestampAtOrBefore(value: string | null, now: Date): boolean {
  if (value === null) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

function scheduledHeartbeatDetails(value: unknown): value is {
  provenanceVersion: 1;
  trigger: "systemd-timer";
  serviceUnit: "precos-daily.service";
  timerUnit: "precos-daily.timer";
  invocationId: string;
  cgroupSha256: string;
  releaseId: string;
  timerLastTriggerAt: string;
  serviceStartedAt: string;
  timerCausalitySha256: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return details.provenanceVersion === 1
    && details.trigger === "systemd-timer"
    && details.serviceUnit === "precos-daily.service"
    && details.timerUnit === "precos-daily.timer"
    && typeof details.invocationId === "string" && /^[a-f0-9]{32}$/u.test(details.invocationId)
    && typeof details.cgroupSha256 === "string" && SHA256.test(details.cgroupSha256)
    && typeof details.releaseId === "string" && /^[a-f0-9]{32}$/u.test(details.releaseId)
    && typeof details.timerLastTriggerAt === "string"
    && Number.isFinite(Date.parse(details.timerLastTriggerAt))
    && typeof details.serviceStartedAt === "string"
    && Number.isFinite(Date.parse(details.serviceStartedAt))
    && Math.abs(Date.parse(details.timerLastTriggerAt) - Date.parse(details.serviceStartedAt)) <= 1_000
    && typeof details.timerCausalitySha256 === "string"
    && SHA256.test(details.timerCausalitySha256)
    && details.timerCausalitySha256 === hash(JSON.stringify({
      invocationId: details.invocationId,
      serviceStartedAt: new Date(details.serviceStartedAt).toISOString(),
      serviceUnit: "precos-daily.service",
      timerLastTriggerAt: new Date(details.timerLastTriggerAt).toISOString(),
      timerUnit: "precos-daily.timer",
    }));
}

function validateHeartbeatLinks(
  database: Database.Database,
  now: Date,
  scope: { deployedAt?: Date; releaseId?: string } = {},
): string[] {
  const rows = database.prepare(`
    SELECT id, scheduled_for, completed_at, details_json
    FROM heartbeats
    WHERE pipeline = 'collect' AND status = 'completed'
    ORDER BY completed_at, id
  `).all() as Array<{
    id: string;
    scheduled_for: string;
    completed_at: string;
    details_json: string;
  }>;
  const contradictions: string[] = [];
  const runEvidence = database.prepare(`
    SELECT run.started_at, run.finished_at,
      MAX(observation.observed_at) AS latest_observation_at
    FROM runs AS run
    LEFT JOIN observations AS observation ON observation.run_id = run.id
    WHERE run.id = ?
    GROUP BY run.id
  `);
  const linkedRunIds = new Set<string>();
  for (const row of rows) {
    if (scope.deployedAt !== undefined
      && Number.isFinite(Date.parse(row.scheduled_for))
      && Date.parse(row.scheduled_for) < scope.deployedAt.getTime()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.details_json);
    } catch {
      contradictions.push(row.id);
      continue;
    }
    const details = typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
    const runIds = details?.runIds;
    const monitorFailures = details?.monitorFailedRunIds;
    const retailerFailures = details?.retailerFailures;
    const invalidFailureEvidence = (monitorFailures !== undefined
      && (!Array.isArray(monitorFailures) || monitorFailures.length !== 0))
      || (retailerFailures !== undefined
        && (!Array.isArray(retailerFailures) || retailerFailures.length !== 0));
    if (!Array.isArray(runIds) || runIds.length === 0
      || runIds.some((id) => typeof id !== "string" || id === "")
      || new Set(runIds).size !== runIds.length
      || invalidFailureEvidence
      || !validTimestampAtOrBefore(row.scheduled_for, now)
      || !validTimestampAtOrBefore(row.completed_at, now)
      || Date.parse(row.completed_at) < Date.parse(row.scheduled_for)
      || ((parsed as Record<string, unknown>).trigger === "systemd-timer"
        && (!scheduledHeartbeatDetails(parsed)
          || (scope.releaseId !== undefined
            && (parsed as Record<string, unknown>).releaseId !== scope.releaseId)))) {
      contradictions.push(row.id);
      continue;
    }
    for (const runId of runIds as string[]) {
      const run = runEvidence.get(runId) as {
        started_at: string;
        finished_at: string | null;
        latest_observation_at: string | null;
      } | undefined;
      if (run === undefined
        || linkedRunIds.has(runId)
        || !validTimestampAtOrBefore(run.started_at, now)
        || !validTimestampAtOrBefore(run.finished_at, now)
        || Date.parse(run.started_at) < Date.parse(row.scheduled_for)
        || Date.parse(run.finished_at ?? "") > Date.parse(row.completed_at)
        || (run.latest_observation_at !== null
          && (!validTimestampAtOrBefore(run.latest_observation_at, now)
            || Date.parse(run.latest_observation_at) < Date.parse(run.started_at)
            || Date.parse(run.latest_observation_at) > Date.parse(run.finished_at ?? "")))) {
        contradictions.push(row.id);
        break;
      }
      linkedRunIds.add(runId);
    }
  }
  return contradictions;
}

function nextDay(day: string): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function hasThreeConsecutiveDays(rows: Array<{ retailer_id: string; collection_day: string }>): boolean {
  const daysByRetailer = new Map<string, Set<string>>();
  for (const row of rows) {
    const days = daysByRetailer.get(row.retailer_id) ?? new Set<string>();
    days.add(row.collection_day);
    daysByRetailer.set(row.retailer_id, days);
  }
  return [...daysByRetailer.values()].some((days) => [...days].some((day) =>
    days.has(nextDay(day)) && days.has(nextDay(nextDay(day)))));
}

function saoPauloDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isScheduledCollectionHeartbeat(input: {
  heartbeat_trigger: string | null;
  timer_unit: string | null;
  service_unit: string | null;
  provenance_version: number | null;
  invocation_id: string | null;
  cgroup_sha256: string | null;
  release_id: string | null;
  timer_last_trigger_at: string | null;
  service_started_at: string | null;
  timer_causality_sha256: string | null;
}): boolean {
  return scheduledHeartbeatDetails({
    provenanceVersion: input.provenance_version,
    trigger: input.heartbeat_trigger,
    serviceUnit: input.service_unit,
    timerUnit: input.timer_unit,
    invocationId: input.invocation_id,
    cgroupSha256: input.cgroup_sha256,
    releaseId: input.release_id,
    timerLastTriggerAt: input.timer_last_trigger_at,
    serviceStartedAt: input.service_started_at,
    timerCausalitySha256: input.timer_causality_sha256,
  });
}

function dailyBoundary(day: string): Date {
  // São Paulo is UTC-03:00 for the charter's 2026 evidence window.
  return new Date(`${day}T06:00:00.000Z`);
}

function scheduledBoundaryAfter(activation: Date, hour: number, minute: number): Date {
  const day = saoPauloDay(activation);
  const candidate = new Date(`${day}T${String(hour + 3).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
  return candidate.getTime() >= activation.getTime()
    ? candidate
    : new Date(`${nextDay(day)}T${String(hour + 3).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
}

function scheduledBoundaryForDay(day: string, hour: number, minute: number): Date {
  return new Date(`${day}T${String(hour + 3).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
}

function deadlineForScheduledStart(start: Date, hour: number, minute: number): Date {
  const candidate = scheduledBoundaryForDay(saoPauloDay(start), hour, minute);
  return candidate.getTime() >= start.getTime()
    ? candidate
    : scheduledBoundaryForDay(nextDay(saoPauloDay(start)), hour, minute);
}

function currentScheduledBoundary(first: Date, now: Date, hour: number, minute: number): Date {
  const today = scheduledBoundaryForDay(saoPauloDay(now), hour, minute);
  return today.getTime() < first.getTime() ? first : today;
}

export function evaluateM2(
  database: Database.Database,
  now: Date,
  scheduleActivatedAt: Date | null = null,
  expectedReleaseId: string | null = null,
): CriterionEvaluation {
  const id = "m2-two-consecutive-days";
  const contradictions = validateHeartbeatLinks(database, now, {
    ...(scheduleActivatedAt === null ? {} : { deployedAt: scheduleActivatedAt }),
    ...(expectedReleaseId === null ? {} : { releaseId: expectedReleaseId }),
  });
  const evidenceId = "db-m2-heartbeat-linked-collection-runs";
  if (contradictions.length > 0) {
    const contradictoryEvidence = evidence(
      evidenceId,
      "database-query",
      "m2-heartbeat-linked-collection-runs",
      now.toISOString(),
      {
        linkedRuns: 0,
        qualifyingRuns: 0,
        qualifyingRetailers: 0,
        qualifyingConsecutiveRetailers: 0,
        qualifyingDayPair: null,
        contradictoryHeartbeats: contradictions.length,
      },
    );
    return {
      criterion: criterion(id, "fail", "Completed collection heartbeat linkage is contradictory", ["EVIDENCE_CONTRADICTION"], [evidenceId]),
      gates: [],
      evidence: [contradictoryEvidence],
    };
  }
  const allRows = database.prepare(M2_QUERY).all() as M2Row[];
  const rows = allRows.filter((row) => isScheduledCollectionHeartbeat(row)
    && (expectedReleaseId === null || (row.release_id === expectedReleaseId
      && scheduleActivatedAt !== null
      && Date.parse(row.scheduled_for) >= scheduleActivatedAt.getTime()))
    && row.collection_day === saoPauloDay(row.scheduled_for));
  const selectedHeartbeatByDay = new Map<string, string>();
  const heartbeatRows = database.prepare(`
    SELECT id, scheduled_for, completed_at,
      json_extract(details_json, '$.trigger') AS heartbeat_trigger,
      json_extract(details_json, '$.timerUnit') AS timer_unit,
      json_extract(details_json, '$.serviceUnit') AS service_unit,
      json_extract(details_json, '$.provenanceVersion') AS provenance_version,
      json_extract(details_json, '$.invocationId') AS invocation_id,
      json_extract(details_json, '$.cgroupSha256') AS cgroup_sha256,
      json_extract(details_json, '$.releaseId') AS release_id,
      json_extract(details_json, '$.timerLastTriggerAt') AS timer_last_trigger_at,
      json_extract(details_json, '$.serviceStartedAt') AS service_started_at,
      json_extract(details_json, '$.timerCausalitySha256') AS timer_causality_sha256
    FROM heartbeats
    WHERE pipeline = 'collect' AND status = 'completed'
      AND COALESCE(json_array_length(details_json, '$.monitorFailedRunIds'), 0) = 0
      AND COALESCE(json_array_length(details_json, '$.retailerFailures'), 0) = 0
    ORDER BY scheduled_for, id
  `).all() as Array<{
    id: string;
    scheduled_for: string;
    completed_at: string;
    heartbeat_trigger: string | null;
    timer_unit: string | null;
    service_unit: string | null;
    provenance_version: number | null;
    invocation_id: string | null;
    cgroup_sha256: string | null;
    release_id: string | null;
    timer_last_trigger_at: string | null;
    service_started_at: string | null;
    timer_causality_sha256: string | null;
  }>;
  const scheduledHeartbeats = heartbeatRows.filter((heartbeat) =>
    isScheduledCollectionHeartbeat(heartbeat)
    && (expectedReleaseId === null || (heartbeat.release_id === expectedReleaseId
      && scheduleActivatedAt !== null
      && Date.parse(heartbeat.scheduled_for) >= scheduleActivatedAt.getTime())));
  for (const heartbeat of scheduledHeartbeats) {
    const day = saoPauloDay(heartbeat.scheduled_for);
    if (!selectedHeartbeatByDay.has(day)) selectedHeartbeatByDay.set(day, heartbeat.id);
  }
  const selectedHeartbeatByRetailerDay = new Map<string, M2Row>();
  for (const row of rows) {
    const key = `${saoPauloDay(row.scheduled_for)}/${row.retailer_id}`;
    const current = selectedHeartbeatByRetailerDay.get(key);
    if (current === undefined
      || `${row.scheduled_for}\0${row.heartbeat_id}` < `${current.scheduled_for}\0${current.heartbeat_id}`) {
      selectedHeartbeatByRetailerDay.set(key, row);
    }
  }
  const qualifying = rows.filter((row) =>
    selectedHeartbeatByRetailerDay.get(`${saoPauloDay(row.scheduled_for)}/${row.retailer_id}`)?.heartbeat_id === row.heartbeat_id
    && row.attempted > 0
    && row.error_category === null
    && row.error_message === null
    && row.attempted === row.ok + row.failed
    && row.ok * 10 >= row.attempted * 9
    && row.attempted >= Math.min(30, row.active_products)
    && row.validation_sample_size === 30
    && row.validation_successes >= 27
    && row.validation_rate !== null
    && row.validation_rate >= 0.9
    && Math.abs(row.validation_rate - row.validation_successes / row.validation_sample_size) < 1e-12
    && row.observation_rows === row.ok
    && row.bound_observation_rows === row.ok);
  const byPair = new Map<string, Set<string>>();
  const daysByRetailer = new Map<string, Set<string>>();
  for (const row of qualifying) {
    const days = daysByRetailer.get(row.retailer_id) ?? new Set<string>();
    days.add(row.collection_day);
    daysByRetailer.set(row.retailer_id, days);
  }
  for (const [retailer, days] of daysByRetailer) {
    for (const day of days) {
      if (!days.has(nextDay(day))) continue;
      const key = `${day}/${nextDay(day)}`;
      const retailers = byPair.get(key) ?? new Set<string>();
      retailers.add(retailer);
      byPair.set(key, retailers);
    }
  }
  const passingPair = [...byPair].find(([, retailers]) => retailers.size >= 2);
  const latestHeartbeat = scheduledHeartbeats.at(-1);
  const resultEvidence = evidence(
    evidenceId,
    "database-query",
    "m2-heartbeat-linked-collection-runs",
    now.toISOString(),
    {
      linkedRuns: rows.length,
      ignoredManualLinkedRuns: allRows.length - rows.length,
      qualifyingRuns: qualifying.length,
      qualifyingRetailers: daysByRetailer.size,
      qualifyingConsecutiveRetailers: passingPair?.[1].size ?? 0,
      qualifyingDayPair: passingPair?.[0] ?? null,
      contradictoryHeartbeats: contradictions.length,
      scheduleActivatedAt: scheduleActivatedAt?.toISOString() ?? null,
      expectedReleaseId,
    },
  );
  if (passingPair !== undefined) {
    return {
      criterion: criterion(id, "pass", "Two retailers have two consecutive qualifying scheduled collection days", [], [evidenceId]),
      gates: [],
      evidence: [resultEvidence],
    };
  }
  const observedDays = [...selectedHeartbeatByDay.keys()].sort();
  const hasMissedInteriorDay = observedDays.some((day, index) => {
    const following = observedDays[index + 1];
    return following !== undefined && nextDay(day) !== following
      && now.getTime() >= scheduledBoundaryAfter(dailyBoundary(nextDay(day)), 4, 0).getTime();
  });
  const latestScheduledDay = latestHeartbeat === undefined ? null : saoPauloDay(latestHeartbeat.scheduled_for);
  const nextBoundaryElapsed = latestScheduledDay !== null
    && now.getTime() >= new Date(`${nextDay(latestScheduledDay)}T07:00:00.000Z`).getTime();
  const firstDeadline = scheduleActivatedAt === null
    ? null
    : deadlineForScheduledStart(scheduledBoundaryAfter(scheduleActivatedAt, 3, 0), 4, 0);
  const noScheduledHeartbeatElapsed = latestScheduledDay === null && firstDeadline !== null
    && now.getTime() >= firstDeadline.getTime();
  if (hasMissedInteriorDay || nextBoundaryElapsed || noScheduledHeartbeatElapsed) {
    return {
      criterion: criterion(id, "fail", "A scheduled collection boundary elapsed without current qualifying evidence", ["MISSED_SCHEDULED_RUN"], [evidenceId]),
      gates: [],
      evidence: [resultEvidence],
    };
  }
  return {
    criterion: criterion(id, "pending", "Two consecutive qualifying collection days have not yet matured", ["TIME_WINDOW_NOT_ELAPSED"], [evidenceId]),
    gates: [gate(id, "time", "TIME_WINDOW_NOT_ELAPSED", latestHeartbeat?.completed_at ?? null, "Let the installed daily schedule collect the next real São Paulo calendar day", "npm run acceptance -- --json", [evidenceId])],
    evidence: [resultEvidence],
  };
}

const M3_QUERY = `
WITH ranked AS (
  SELECT classification.*,
    ROW_NUMBER() OVER (
      PARTITION BY classification.product_id
      ORDER BY classification.version DESC, classification.created_at DESC, classification.id DESC
    ) AS rank
  FROM classifications AS classification
)
SELECT retailer.id AS retailer_id,
  COUNT(product.id) AS active_in_scope_products,
  SUM(CASE WHEN ranked.ipca_item_id IS NOT NULL AND ranked.confidence >= 0.8 THEN 1 ELSE 0 END) AS high_confidence_products
FROM retailers AS retailer
JOIN products AS product ON product.retailer_id = retailer.id
LEFT JOIN ranked ON ranked.product_id = product.id AND ranked.rank = 1
WHERE retailer.active = 1 AND product.active = 1 AND product.in_scope = 1
GROUP BY retailer.id
ORDER BY retailer.id`;

export interface M3GateOptions {
  credentialConfigured: boolean;
  siteValidated: boolean;
  /** Deprecated input retained for callers; environment flags never prove a swap. */
  authorityApproved?: boolean;
  decisionsDocumented?: boolean;
  namedBackupDocumented?: boolean;
  blockedDayTriggerProven?: boolean;
  deployedAt?: Date;
  releaseId?: string;
}

export interface M3Evaluation {
  criteria: AcceptanceCriterion[];
  gates: PendingGate[];
  evidence: AcceptanceEvidence[];
}

export function evaluateM3(
  database: Database.Database,
  options: M3GateOptions,
  now = new Date(),
): M3Evaluation {
  const rows = database.prepare(M3_QUERY).all() as Array<{
    retailer_id: string;
    active_in_scope_products: number;
    high_confidence_products: number;
  }>;
  const retailerFacts = database.prepare(`
    SELECT COUNT(*) AS activeRetailers,
      SUM(CASE WHEN degraded = 1 THEN 1 ELSE 0 END) AS degradedRetailers
    FROM retailers WHERE active = 1
  `).get() as { activeRetailers: number; degradedRetailers: number };
  const activeProducts = rows.reduce((sum, row) => sum + row.active_in_scope_products, 0);
  const highConfidence = rows.reduce((sum, row) => sum + row.high_confidence_products, 0);
  const ratioPass = activeProducts > 0 && highConfidence * 5 >= activeProducts * 4;
  const panelExceptionPass = retailerFacts.activeRetailers === 3
    && options.decisionsDocumented === true
    && options.namedBackupDocumented === true
    && options.blockedDayTriggerProven === true;
  const panelPass = retailerFacts.activeRetailers >= 4 || panelExceptionPass;

  const contradictions = validateHeartbeatLinks(database, now, {
    ...(options.deployedAt === undefined ? {} : { deployedAt: options.deployedAt }),
    ...(options.releaseId === undefined ? {} : { releaseId: options.releaseId }),
  });
  const scheduledRows = contradictions.length === 0
    ? (database.prepare(M2_QUERY).all() as M2Row[]).filter((row) =>
        isScheduledCollectionHeartbeat(row)
        && (options.releaseId === undefined || (row.release_id === options.releaseId
          && options.deployedAt !== undefined
          && Date.parse(row.scheduled_for) >= options.deployedAt.getTime()))
        && row.collection_day === saoPauloDay(row.scheduled_for))
    : [];
  const heartbeatCandidates = database.prepare(`
    SELECT id, scheduled_for, completed_at, status, details_json
    FROM heartbeats
    WHERE pipeline = 'collect'
    ORDER BY completed_at DESC, id DESC
  `).all() as Array<{
    id: string;
    scheduled_for: string;
    completed_at: string;
    status: string;
    details_json: string;
  }>;
  const latestHeartbeat = heartbeatCandidates.find((heartbeat) => {
    if (options.deployedAt !== undefined
      && Date.parse(heartbeat.scheduled_for) < options.deployedAt.getTime()) return false;
    try {
      const parsed = JSON.parse(heartbeat.details_json) as Record<string, unknown>;
      return parsed.trigger === "systemd-timer";
    } catch {
      return false;
    }
  });
  const latestHeartbeatId = latestHeartbeat?.id ?? null;
  let latestHeartbeatScheduled = false;
  if (latestHeartbeat !== undefined && latestHeartbeat.status === "completed") {
    try {
      const parsed = JSON.parse(latestHeartbeat.details_json);
      latestHeartbeatScheduled = scheduledHeartbeatDetails(parsed)
        && (options.releaseId === undefined || parsed.releaseId === options.releaseId);
    } catch {
      latestHeartbeatScheduled = false;
    }
  }
  const latestHeartbeatRows = latestHeartbeatId === null
    ? []
    : scheduledRows.filter((row) => latestHeartbeatScheduled && row.heartbeat_id === latestHeartbeatId);
  const substantiveRows = latestHeartbeatRows.filter((row) =>
    Date.parse(row.completed_at) >= now.getTime() - 24 * 60 * 60 * 1_000
    && row.attempted > 0
    && row.error_category === null
    && row.error_message === null
    && row.attempted === row.ok + row.failed
    && row.ok * 10 >= row.attempted * 7
    && row.attempted >= Math.min(30, row.active_products)
    && row.validation_sample_size === 30
    && row.validation_successes >= 27
    && row.validation_rate !== null
    && row.validation_rate >= 0.9
    && Math.abs(row.validation_rate - row.validation_successes / row.validation_sample_size) < 1e-12
    && row.observation_rows === row.ok
    && row.bound_observation_rows === row.ok);
  const substantiveRetailers = new Set(substantiveRows.map((row) => row.retailer_id));
  const duplicateLatestRetailers = latestHeartbeatRows.length
    - new Set(latestHeartbeatRows.map((row) => row.retailer_id)).size;
  const retailersWithCollectionEvidence = substantiveRetailers.size;
  const latestScheduledAt = latestHeartbeat?.completed_at ?? null;
  const latestHeartbeatCoversPanel = latestHeartbeatRows.length === retailerFacts.activeRetailers
    && substantiveRows.length === retailerFacts.activeRetailers
    && retailersWithCollectionEvidence === retailerFacts.activeRetailers
    && duplicateLatestRetailers === 0;

  const panelEvidenceId = "db-m3-live-panel";
  const panelEvidence = evidence(panelEvidenceId, "database-query", "m3-live-panel", now.toISOString(), {
    activeRetailers: retailerFacts.activeRetailers,
    degradedRetailers: retailerFacts.degradedRetailers,
    panelExceptionApproved: panelExceptionPass,
    recentScheduledSubstantiveRetailers: retailersWithCollectionEvidence,
    latestHeartbeatId,
    latestHeartbeatRunRows: latestHeartbeatRows.length,
    duplicateLatestRetailers,
    latestScheduledCollectionCompletedAt: latestScheduledAt,
    contradictoryHeartbeats: contradictions.length,
  });
  const classificationEvidenceId = "db-m3-latest-classification-coverage";
  const classificationEvidence = evidence(classificationEvidenceId, "database-query", "m3-latest-classification-coverage", now.toISOString(), {
    activeRetailers: retailerFacts.activeRetailers,
    activeProducts,
    highConfidenceProducts: highConfidence,
    classificationCoverage: activeProducts === 0 ? 0 : highConfidence / activeProducts,
  });

  let panelCriterion: AcceptanceCriterion;
  let panelGate: PendingGate | null = null;
  if (retailerFacts.degradedRetailers > 0) {
    panelCriterion = criterion("m3-live-panel", "fail", "An active retailer is degraded", ["UNSAFE_CONFIGURATION"], [panelEvidenceId]);
  } else if (contradictions.length > 0) {
    panelCriterion = criterion("m3-live-panel", "fail", "Scheduled panel heartbeat evidence is contradictory", ["EVIDENCE_CONTRADICTION"], [panelEvidenceId]);
  } else if (!panelPass) {
    panelCriterion = criterion("m3-live-panel", "pending", "A fourth validated live retailer or documented exception is still required", ["SITE_VALIDATION_PENDING"], [panelEvidenceId]);
    panelGate = gate("m3-live-panel", "site", "SITE_VALIDATION_PENDING", null,
      "Activate a validated fourth retailer or record the exact named-backup swap after three blocked days",
      "npm run acceptance -- --json", [panelEvidenceId]);
  } else if (!latestHeartbeatCoversPanel) {
    const staleScheduledEvidence = latestScheduledAt !== null
      && Date.parse(latestScheduledAt) < now.getTime() - 24 * 60 * 60 * 1_000;
    if (staleScheduledEvidence) {
      panelCriterion = criterion("m3-live-panel", "fail", "The latest scheduled panel collection is older than 24 hours", ["MISSED_SCHEDULED_RUN"], [panelEvidenceId]);
    } else if (latestScheduledAt !== null) {
      panelCriterion = criterion("m3-live-panel", "fail", "The latest scheduled collection did not substantively collect every active retailer", ["EVIDENCE_CONTRADICTION"], [panelEvidenceId]);
    } else {
      panelCriterion = criterion("m3-live-panel", "pending", "The live panel awaits its first substantive scheduled collection", ["SCHEDULED_RUN_NOT_YET_DUE"], [panelEvidenceId]);
      panelGate = gate("m3-live-panel", "time", "SCHEDULED_RUN_NOT_YET_DUE", null,
        "Let the installed daily schedule collect every active retailer with a healthy substantive run",
        "npm run acceptance -- --json", [panelEvidenceId]);
    }
  } else {
    panelCriterion = criterion("m3-live-panel", "pass", "The live panel has current substantive scheduled collection evidence", [], [panelEvidenceId]);
  }

  let classificationCriterion: AcceptanceCriterion;
  let classificationGate: PendingGate | null = null;
  if (ratioPass) {
    classificationCriterion = criterion("m3-classification-coverage", "pass", "Latest-version high-confidence classification covers at least 80% of active products", [], [classificationEvidenceId]);
  } else if (!options.credentialConfigured) {
    classificationCriterion = criterion("m3-classification-coverage", "pending", "High-confidence classification coverage remains credential-gated", ["CREDENTIAL_NOT_CONFIGURED"], [classificationEvidenceId]);
    classificationGate = gate("m3-classification-coverage", "credential", "CREDENTIAL_NOT_CONFIGURED", null,
      "Configure the classification credential privately, then run the normal reviewed classification workflow",
      "npm run acceptance -- --json", [classificationEvidenceId]);
  } else {
    classificationCriterion = criterion("m3-classification-coverage", "fail", "Configured classification evidence does not meet the 80% threshold", ["EVIDENCE_CONTRADICTION"], [classificationEvidenceId]);
  }

  return {
    criteria: [panelCriterion, classificationCriterion],
    gates: [panelGate, classificationGate].filter((item): item is PendingGate => item !== null),
    evidence: [panelEvidence, classificationEvidence],
  };
}

export function evaluateClassificationHumanReview(
  root: string,
  database: Database.Database,
  now: Date,
): CriterionEvaluation {
  const id = "m3-classification-human-review";
  const latest = database.prepare(`
    SELECT MAX(classification.version) AS version,
      COUNT(DISTINCT classification.id) AS classification_rows
    FROM classifications AS classification
    JOIN products AS product ON product.id = classification.product_id
    JOIN retailers AS retailer ON retailer.id = product.retailer_id
    WHERE retailer.active = 1 AND product.active = 1 AND product.in_scope = 1
  `).get() as { version: number | null; classification_rows: number };
  const relativePath = latest.version === null
    ? "data/acceptance/evidence/classification-review-vN.json"
    : `data/acceptance/evidence/classification-review-v${latest.version}.json`;
  const path = join(root, relativePath);
  let artifactValid = false;
  let precision: number | null = null;
  let agreementRate: number | null = null;
  let sampleSize = 0;
  let populationSize = 0;
  let artifactHash: string | undefined;
  if (latest.version !== null && existsSync(path)) {
    try {
      const result = readClassificationReviewResult(database, path, {
        now,
        requiredSize: CLASSIFICATION_REVIEW_SIZE,
      });
      artifactValid = result.classificationVersion === latest.version
        && result.reviewerRefSha256 !== "0".repeat(64);
      precision = result.overall.precision;
      agreementRate = result.overall.agreementRate;
      sampleSize = result.sampleSize;
      populationSize = result.populationSize;
      artifactHash = hash(readFileSync(path));
    } catch {
      artifactValid = false;
    }
  }
  const evidenceId = "file-m3-classification-human-review";
  const item = evidence(evidenceId, "file", relativePath, now.toISOString(), {
    latestClassificationVersion: latest.version,
    activeClassificationRows: latest.classification_rows,
    artifactPresent: latest.version !== null && existsSync(path),
    artifactValid,
    requiredSampleSize: CLASSIFICATION_REVIEW_SIZE,
    sampleSize,
    populationSize,
    precision,
    agreementRate,
  }, artifactHash);
  if (artifactValid && precision !== null) {
    return {
      criterion: criterion(id, "pass", "A completed 200-row human review is bound to the current classification version", [], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  if (latest.version !== null && existsSync(path)) {
    return {
      criterion: criterion(id, "fail", "The classification human-review artifact is malformed, stale, or misbound", ["EVIDENCE_CONTRADICTION"], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  return {
    criterion: criterion(id, "pending", "The classification precision check awaits an explicit human review", ["AUTHORITY_APPROVAL_REQUIRED"], [evidenceId]),
    gates: [gate(
      id,
      "authority",
      "AUTHORITY_APPROVAL_REQUIRED",
      null,
      "Run scripts/classification-review.ts export, have the author label every row, then run its evaluate command",
      "npm run acceptance -- --json",
      [evidenceId],
    )],
    evidence: [item],
  };
}

interface StrategyReceiptRow {
  id: string;
  retailer_id: string;
  purpose: "discovery" | "extraction";
  version: number;
  strategy_json: string;
  validation_sample_size: number;
  validation_successes: number;
  validation_rate: number | null;
  validated_at: string | null;
  activated_at: string | null;
  retired_at: string | null;
  active: number;
  provenance: string;
}

const SUCCESSOR_PLAN_PATH = "data/validation/successor-plans.json";
const SUCCESSOR_RECOVERY_PLAN_PATH = "data/validation/successor-recovery-plan.json";
const SUCCESSOR_RECOVERY_CHAIN_PATH = "data/validation/successor-recovery-chain.json";

function committedBlob(root: string, sourceCommit: string, path: string): Buffer {
  return execFileSync(
    "git",
    ["show", `${sourceCommit}:${path}`],
    { cwd: root, encoding: null, stdio: ["ignore", "pipe", "ignore"] },
  );
}

function committedJson(root: string, sourceCommit: string, path: string): unknown {
  return JSON.parse(committedBlob(root, sourceCommit, path).toString("utf8"));
}

function committedRegularFile(root: string, sourceCommit: string, path: string): boolean {
  return git(root, ["ls-tree", sourceCommit, "--", path]).startsWith("100644 blob ");
}

function recoveryPlanDeclaresStrategyVersion(
  root: string,
  sourceCommit: string,
  historicalConfig: RetailerConfig,
  input: {
    retailerId: string;
    purpose: "discovery" | "extraction";
    version: number;
    strategy: ReturnType<typeof parseStrategy>;
  },
): boolean {
  if (!committedRegularFile(root, sourceCommit, SUCCESSOR_RECOVERY_PLAN_PATH)) return false;
  const rawPlan = committedJson(root, sourceCommit, SUCCESSOR_RECOVERY_PLAN_PATH);
  if (typeof rawPlan !== "object" || rawPlan === null || Array.isArray(rawPlan)) return false;
  const recovery = rawPlan as Record<string, unknown>;
  if (!exactObjectKeys(recovery, ["schemaVersion", "parent", "plans"])
    || recovery.schemaVersion !== 1
    || typeof recovery.parent !== "object" || recovery.parent === null
    || Array.isArray(recovery.parent)
    || !Array.isArray(recovery.plans)
    || recovery.plans.length !== 2) return false;
  const parent = recovery.parent as Record<string, unknown>;
  if (!exactObjectKeys(parent, [
    "sourceCommit", "planPath", "planFileSha256", "validatorArtifactSha256",
    "attestationKeyId",
  ])
    || typeof parent.sourceCommit !== "string" || !COMMIT.test(parent.sourceCommit)
    || parent.sourceCommit === sourceCommit
    || parent.planPath !== SUCCESSOR_PLAN_PATH
    || typeof parent.planFileSha256 !== "string" || !SHA256.test(parent.planFileSha256)
    || typeof parent.validatorArtifactSha256 !== "string"
      || !SHA256.test(parent.validatorArtifactSha256)
    || typeof parent.attestationKeyId !== "string" || !SHA256.test(parent.attestationKeyId)
    || !gitSucceeds(root, ["merge-base", "--is-ancestor", parent.sourceCommit, sourceCommit])
    || !committedRegularFile(root, parent.sourceCommit, SUCCESSOR_PLAN_PATH)
    || hash(committedBlob(root, parent.sourceCommit, SUCCESSOR_PLAN_PATH))
      !== parent.planFileSha256
    || committedBlob(root, sourceCommit, "ops/validator-bundle.sha256")
      .toString("utf8").trim() !== parent.validatorArtifactSha256) return false;
  const publicKey = createPublicKey(committedBlob(
    root,
    sourceCommit,
    "ops/validation-attestation-public.pem",
  ));
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  if (hash(publicKeyDer) !== parent.attestationKeyId) return false;

  const planKeys = [
    "retailerId", "purpose", "activeVersion", "failedVersion", "toVersion",
    "activeStrategySha256", "failedStrategySha256", "candidatePath",
    "candidateFileSha256", "strategySha256", "failedAttemptPath",
    "failedAttemptFileSha256", "failedAttemptReceiptSha256",
    "failedAttemptSampleSetSha256", "configPatch", "reason",
  ];
  const identities = new Set<string>();
  const parsedPlans = recovery.plans.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new TypeError("Recovery plan entry must be an object");
    }
    const value = candidate as Record<string, unknown>;
    if (!exactObjectKeys(value, planKeys)
      || typeof value.retailerId !== "string"
      || (value.purpose !== "discovery" && value.purpose !== "extraction")
      || !Number.isSafeInteger(value.activeVersion) || (value.activeVersion as number) <= 0
      || value.failedVersion !== (value.activeVersion as number) + 1
      || value.toVersion !== (value.failedVersion as number) + 1
      || typeof value.activeStrategySha256 !== "string"
        || !SHA256.test(value.activeStrategySha256)
      || typeof value.failedStrategySha256 !== "string"
        || !SHA256.test(value.failedStrategySha256)
      || typeof value.candidatePath !== "string"
      || typeof value.candidateFileSha256 !== "string"
        || !SHA256.test(value.candidateFileSha256)
      || typeof value.strategySha256 !== "string" || !SHA256.test(value.strategySha256)
      || value.strategySha256 === value.activeStrategySha256
      || value.strategySha256 === value.failedStrategySha256
      || typeof value.failedAttemptPath !== "string"
      || typeof value.failedAttemptFileSha256 !== "string"
        || !SHA256.test(value.failedAttemptFileSha256)
      || typeof value.failedAttemptReceiptSha256 !== "string"
        || !SHA256.test(value.failedAttemptReceiptSha256)
      || typeof value.failedAttemptSampleSetSha256 !== "string"
        || !SHA256.test(value.failedAttemptSampleSetSha256)
      || typeof value.configPatch !== "object" || value.configPatch === null
      || Array.isArray(value.configPatch)
      || typeof value.reason !== "string" || value.reason.trim() !== value.reason
      || value.reason.length === 0) throw new TypeError("Recovery plan entry is malformed");
    const identity = value.retailerId + "/" + value.purpose;
    const patch = value.configPatch as Record<string, unknown>;
    const expectedPatchKeys = identity === "carrefour/extraction"
      ? ["cep", "platformEvidence", "storeMapping"]
      : [];
    if (!exactObjectKeys(patch, expectedPatchKeys)) {
      throw new TypeError("Recovery config patch has unauthorized fields");
    }
    if (identities.has(identity)) throw new TypeError("Recovery plan identity is duplicated");
    identities.add(identity);
    return value;
  });
  if ([...identities].sort().join("\0")
    !== ["carrefour/extraction", "extra-mercado/discovery"].sort().join("\0")) return false;
  const matches = parsedPlans.filter((plan) => plan.retailerId === input.retailerId
    && plan.purpose === input.purpose
    && plan.toVersion === input.version
    && plan.strategySha256 === strategyEvidenceSha256(input.strategy));
  if (matches.length !== 1) return false;
  const plan = matches[0]!;
  const purpose = input.purpose;
  if (historicalConfig.strategyVersions[purpose] !== plan.activeVersion
    || strategyEvidenceSha256(historicalConfig[purpose]) !== plan.activeStrategySha256) return false;
  const expectedCandidatePath = `data/validation/candidates/${input.retailerId}-${purpose}-v${input.version}.json`;
  const expectedAttemptPath = `data/validation/attempts/${input.retailerId}-${purpose}-v${plan.failedVersion}.json`;
  if (plan.candidatePath !== expectedCandidatePath
    || plan.failedAttemptPath !== expectedAttemptPath
    || !committedRegularFile(root, sourceCommit, expectedCandidatePath)
    || !committedRegularFile(root, sourceCommit, expectedAttemptPath)) return false;
  const candidateRaw = committedBlob(root, sourceCommit, expectedCandidatePath);
  const candidate = parseStrategy(JSON.parse(candidateRaw.toString("utf8")));
  if (hash(candidateRaw) !== plan.candidateFileSha256
    || strategyEvidenceSha256(candidate) !== plan.strategySha256
    || strategyEvidenceSha256(candidate) !== strategyEvidenceSha256(input.strategy)
    || candidate.purpose !== purpose) return false;
  const projectedConfig = structuredClone(historicalConfig) as RetailerConfig;
  Object.assign(projectedConfig, plan.configPatch as Record<string, unknown>);
  projectedConfig[purpose] = candidate as never;
  projectedConfig.strategyVersions[purpose] = input.version;
  projectedConfig.validation[purpose].receiptPath =
    `data/validation/${input.retailerId}-${purpose}-v${input.version}.json`;
  RetailerConfigSchema.parse(projectedConfig);

  const parentConfig = RetailerConfigSchema.parse(committedJson(
    root,
    parent.sourceCommit as string,
    `retailers/${input.retailerId}.json`,
  ));
  const failedStrategy = parentConfig[purpose];
  if (parentConfig.strategyVersions[purpose] !== plan.activeVersion
    || strategyEvidenceSha256(failedStrategy) !== plan.failedStrategySha256
    || !sourceCommitDeclaresStrategyVersion(root, parent.sourceCommit as string, {
      retailerId: input.retailerId,
      purpose,
      version: plan.failedVersion as number,
      strategy: failedStrategy,
    })) return false;
  const failedRaw = committedBlob(root, sourceCommit, expectedAttemptPath);
  const failed = StrategyValidationEvidenceSchema.parse(JSON.parse(failedRaw.toString("utf8")));
  const validatedFailure = validateStrategyEvidence(failed, {
    retailerId: input.retailerId,
    purpose,
    strategyVersion: plan.failedVersion as number,
    strategy: failedStrategy,
    verificationPublicKey: publicKey,
  });
  if (hash(failedRaw) !== plan.failedAttemptFileSha256
    || validationReceiptSha256(validatedFailure) !== plan.failedAttemptReceiptSha256
    || validatedFailure.sampleSetSha256 !== plan.failedAttemptSampleSetSha256
    || validatedFailure.attempted !== 30 || validatedFailure.valid >= 27
    || validatedFailure.activatable !== false
    || validatedFailure.executor.sourceCommit !== parent.sourceCommit
    || validatedFailure.executor.artifactSha256 !== parent.validatorArtifactSha256
    || validatedFailure.attestation.keyId !== parent.attestationKeyId) return false;
  const manifest = committedJson(
    root,
    sourceCommit,
    "data/validation/attempts/manifest.json",
  ) as { schemaVersion?: unknown; attempts?: unknown };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.attempts)) return false;
  const manifestMatches = manifest.attempts.filter((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const value = entry as Record<string, unknown>;
    return exactObjectKeys(value, [
      "fileSha256", "path", "receiptSha256", "strategySourceCommit",
    ])
      && value.path === expectedAttemptPath
      && value.fileSha256 === plan.failedAttemptFileSha256
      && value.receiptSha256 === plan.failedAttemptReceiptSha256
      && value.strategySourceCommit === parent.sourceCommit;
  });
  return manifestMatches.length === 1;
}

function recoveryChainDeclaresStrategyVersion(
  root: string,
  sourceCommit: string,
  historicalConfig: RetailerConfig,
  input: {
    retailerId: string;
    purpose: "discovery" | "extraction";
    version: number;
    strategy: ReturnType<typeof parseStrategy>;
  },
): boolean {
  if (!committedRegularFile(root, sourceCommit, SUCCESSOR_RECOVERY_CHAIN_PATH)) return false;
  const raw = committedJson(root, sourceCommit, SUCCESSOR_RECOVERY_CHAIN_PATH);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const chain = raw as Record<string, unknown>;
  if (!exactObjectKeys(chain, ["schemaVersion", "parent", "plan"])
    || chain.schemaVersion !== 1
    || typeof chain.parent !== "object" || chain.parent === null || Array.isArray(chain.parent)
    || typeof chain.plan !== "object" || chain.plan === null || Array.isArray(chain.plan)) {
    return false;
  }
  const parent = chain.parent as Record<string, unknown>;
  if (!exactObjectKeys(parent, [
    "sourceCommit", "planPath", "planFileSha256", "validatorArtifactSha256",
    "attestationKeyId",
  ])
    || typeof parent.sourceCommit !== "string" || !COMMIT.test(parent.sourceCommit)
    || parent.sourceCommit === sourceCommit
    || parent.planPath !== SUCCESSOR_RECOVERY_PLAN_PATH
    || typeof parent.planFileSha256 !== "string" || !SHA256.test(parent.planFileSha256)
    || typeof parent.validatorArtifactSha256 !== "string"
      || !SHA256.test(parent.validatorArtifactSha256)
    || typeof parent.attestationKeyId !== "string" || !SHA256.test(parent.attestationKeyId)
    || !gitSucceeds(root, ["merge-base", "--is-ancestor", parent.sourceCommit, sourceCommit])
    || !committedRegularFile(root, parent.sourceCommit, SUCCESSOR_RECOVERY_PLAN_PATH)
    || hash(committedBlob(root, parent.sourceCommit, SUCCESSOR_RECOVERY_PLAN_PATH))
      !== parent.planFileSha256
    || committedBlob(root, sourceCommit, "ops/validator-bundle.sha256")
      .toString("utf8").trim() !== parent.validatorArtifactSha256) return false;
  const publicKey = createPublicKey(committedBlob(
    root,
    sourceCommit,
    "ops/validation-attestation-public.pem",
  ));
  if (hash(publicKey.export({ type: "spki", format: "der" })) !== parent.attestationKeyId) {
    return false;
  }
  const plan = chain.plan as Record<string, unknown>;
  if (!exactObjectKeys(plan, [
    "retailerId", "purpose", "activeVersion", "ancestorFailedVersions", "failedVersion",
    "toVersion", "activeStrategySha256", "failedStrategySha256", "candidatePath",
    "candidateFileSha256", "strategySha256", "failedAttemptPath",
    "failedAttemptFileSha256", "failedAttemptReceiptSha256",
    "failedAttemptSampleSetSha256", "configPatch", "reason",
  ])
    || plan.retailerId !== "carrefour" || plan.purpose !== "extraction"
    || plan.retailerId !== input.retailerId || plan.purpose !== input.purpose
    || !Number.isSafeInteger(plan.activeVersion) || (plan.activeVersion as number) <= 0
    || !Array.isArray(plan.ancestorFailedVersions)
    || plan.ancestorFailedVersions.length === 0
    || plan.ancestorFailedVersions.some((version, index) =>
      !Number.isSafeInteger(version)
      || version !== (plan.activeVersion as number) + index + 1)
    || plan.failedVersion
      !== (plan.ancestorFailedVersions.at(-1) as number) + 1
    || plan.toVersion !== (plan.failedVersion as number) + 1
    || plan.toVersion !== input.version
    || typeof plan.activeStrategySha256 !== "string" || !SHA256.test(plan.activeStrategySha256)
    || typeof plan.failedStrategySha256 !== "string" || !SHA256.test(plan.failedStrategySha256)
    || typeof plan.strategySha256 !== "string" || !SHA256.test(plan.strategySha256)
    || plan.strategySha256 === plan.activeStrategySha256
    || plan.strategySha256 === plan.failedStrategySha256
    || plan.strategySha256 !== strategyEvidenceSha256(input.strategy)
    || typeof plan.candidatePath !== "string"
    || plan.candidatePath
      !== `data/validation/candidates/${input.retailerId}-${input.purpose}-v${input.version}.json`
    || typeof plan.candidateFileSha256 !== "string" || !SHA256.test(plan.candidateFileSha256)
    || typeof plan.failedAttemptPath !== "string"
    || plan.failedAttemptPath
      !== `data/validation/attempts/${input.retailerId}-${input.purpose}-v${plan.failedVersion}.json`
    || typeof plan.failedAttemptFileSha256 !== "string"
      || !SHA256.test(plan.failedAttemptFileSha256)
    || typeof plan.failedAttemptReceiptSha256 !== "string"
      || !SHA256.test(plan.failedAttemptReceiptSha256)
    || typeof plan.failedAttemptSampleSetSha256 !== "string"
      || !SHA256.test(plan.failedAttemptSampleSetSha256)
    || typeof plan.configPatch !== "object" || plan.configPatch === null
      || Array.isArray(plan.configPatch)
    || !exactObjectKeys(plan.configPatch as Record<string, unknown>, [
      "cep", "platformEvidence", "storeMapping",
    ])
    || typeof plan.reason !== "string" || plan.reason.trim() !== plan.reason
    || plan.reason.length === 0) return false;
  if (historicalConfig.strategyVersions[input.purpose] !== plan.activeVersion
    || strategyEvidenceSha256(historicalConfig[input.purpose])
      !== plan.activeStrategySha256) return false;
  const candidateRaw = committedBlob(root, sourceCommit, plan.candidatePath as string);
  const candidate = parseStrategy(JSON.parse(candidateRaw.toString("utf8")));
  if (!committedRegularFile(root, sourceCommit, plan.candidatePath as string)
    || hash(candidateRaw) !== plan.candidateFileSha256
    || strategyEvidenceSha256(candidate) !== plan.strategySha256
    || strategyEvidenceSha256(candidate) !== strategyEvidenceSha256(input.strategy)) return false;
  const projected = structuredClone(historicalConfig) as RetailerConfig;
  Object.assign(projected, plan.configPatch as Record<string, unknown>);
  projected[input.purpose] = candidate as never;
  projected.strategyVersions[input.purpose] = input.version;
  projected.validation[input.purpose].receiptPath =
    `data/validation/${input.retailerId}-${input.purpose}-v${input.version}.json`;
  RetailerConfigSchema.parse(projected);

  const parentPlan = committedJson(
    root,
    parent.sourceCommit,
    parent.planPath as string,
  ) as { schemaVersion?: unknown; plans?: unknown };
  if (parentPlan.schemaVersion !== 1 || !Array.isArray(parentPlan.plans)) return false;
  const parentMatches = parentPlan.plans.filter((candidatePlan) => {
    if (typeof candidatePlan !== "object" || candidatePlan === null
      || Array.isArray(candidatePlan)) return false;
    const value = candidatePlan as Record<string, unknown>;
    return value.retailerId === input.retailerId
      && value.purpose === input.purpose
      && value.toVersion === plan.failedVersion
      && value.strategySha256 === plan.failedStrategySha256
      && typeof value.candidatePath === "string";
  }) as Array<Record<string, unknown>>;
  if (parentMatches.length !== 1 || typeof parentMatches[0]?.candidatePath !== "string") {
    return false;
  }
  const failedStrategy = parseStrategy(committedJson(
    root,
    parent.sourceCommit,
    parentMatches[0].candidatePath,
  ));
  if (strategyEvidenceSha256(failedStrategy) !== plan.failedStrategySha256
    || !sourceCommitDeclaresStrategyVersion(root, parent.sourceCommit as string, {
      retailerId: input.retailerId,
      purpose: input.purpose,
      version: plan.failedVersion as number,
      strategy: failedStrategy,
    })) return false;
  const failedRaw = committedBlob(root, sourceCommit, plan.failedAttemptPath as string);
  if (!committedRegularFile(root, sourceCommit, plan.failedAttemptPath as string)
    || hash(failedRaw) !== plan.failedAttemptFileSha256) return false;
  const failed = validateStrategyEvidence(
    StrategyValidationEvidenceSchema.parse(JSON.parse(failedRaw.toString("utf8"))),
    {
      retailerId: input.retailerId,
      purpose: input.purpose,
      strategyVersion: plan.failedVersion as number,
      strategy: failedStrategy,
      verificationPublicKey: publicKey,
    },
  );
  if (validationReceiptSha256(failed) !== plan.failedAttemptReceiptSha256
    || failed.sampleSetSha256 !== plan.failedAttemptSampleSetSha256
    || failed.attempted !== 30 || failed.valid >= 27 || failed.activatable !== false
    || failed.executor.sourceCommit !== parent.sourceCommit
    || failed.executor.artifactSha256 !== parent.validatorArtifactSha256
    || failed.attestation.keyId !== parent.attestationKeyId) return false;
  const manifest = committedJson(
    root,
    sourceCommit,
    "data/validation/attempts/manifest.json",
  ) as { schemaVersion?: unknown; attempts?: unknown };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.attempts)) return false;
  const entries = manifest.attempts.filter((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const value = entry as Record<string, unknown>;
    return exactObjectKeys(value, [
      "fileSha256", "path", "receiptSha256", "strategySourceCommit",
    ])
      && value.path === plan.failedAttemptPath
      && value.fileSha256 === plan.failedAttemptFileSha256
      && value.receiptSha256 === plan.failedAttemptReceiptSha256
      && value.strategySourceCommit === parent.sourceCommit;
  });
  return entries.length === 1;
}

function successorPlanStrategy(
  root: string,
  sourceCommit: string,
  historicalConfig: RetailerConfig,
  retailerId: string,
  purpose: "discovery" | "extraction",
  version: number,
): ReturnType<typeof parseStrategy> | null {
  const plan = committedJson(root, sourceCommit, SUCCESSOR_PLAN_PATH) as {
    schemaVersion?: unknown;
    plans?: unknown;
  };
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.plans)) return null;
  const matches = plan.plans.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
    const value = candidate as Record<string, unknown>;
    const hasBurnedVersions = Object.hasOwn(value, "burnedVersions");
    const hasCandidateStrategy = Object.hasOwn(value, "candidateStrategy");
    const hasSourceStrategySha256 = Object.hasOwn(value, "sourceStrategySha256");
    if (hasCandidateStrategy !== hasSourceStrategySha256) return [];
    const expectedKeys = [
      "fromVersion", "purpose", "reason", "retailerId", "strategySha256", "toVersion",
      ...(hasBurnedVersions ? ["burnedVersions"] : []),
      ...(hasCandidateStrategy ? ["candidateStrategy", "sourceStrategySha256"] : []),
    ];
    const burnedVersions = hasBurnedVersions ? value.burnedVersions : [];
    if (!exactObjectKeys(value, expectedKeys)
      || value.retailerId !== retailerId
      || value.purpose !== purpose
      || !Number.isSafeInteger(value.fromVersion) || (value.fromVersion as number) < 1
      || value.fromVersion !== historicalConfig.strategyVersions[purpose]
      || value.toVersion !== version
      || !Array.isArray(burnedVersions)
      || burnedVersions.some((burnedVersion, index) =>
        !Number.isSafeInteger(burnedVersion)
        || burnedVersion !== (value.fromVersion as number) + index + 1)
      || version !== (value.fromVersion as number) + burnedVersions.length + 1
      || typeof value.strategySha256 !== "string" || !SHA256.test(value.strategySha256)
      || typeof value.reason !== "string" || value.reason.trim().length === 0) return [];
    const sourceStrategy = historicalConfig[purpose];
    const sourceStrategySha256 = strategyEvidenceSha256(sourceStrategy);
    let targetStrategy: ReturnType<typeof parseStrategy>;
    if (hasCandidateStrategy) {
      if (value.sourceStrategySha256 !== sourceStrategySha256) return [];
      targetStrategy = parseStrategy(value.candidateStrategy);
      if (targetStrategy.purpose !== purpose) return [];
    } else {
      targetStrategy = sourceStrategy;
    }
    return strategyEvidenceSha256(targetStrategy) === value.strategySha256
      ? [targetStrategy]
      : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

function declaredStrategyAtSourceCommit(
  root: string,
  sourceCommit: string,
  retailerId: string,
  purpose: "discovery" | "extraction",
  version: number,
): ReturnType<typeof parseStrategy> | null {
  try {
    const historicalConfig = RetailerConfigSchema.parse(committedJson(
      root,
      sourceCommit,
      `retailers/${retailerId}.json`,
    ));
    if (historicalConfig.strategyVersions[purpose] === version) {
      return historicalConfig[purpose];
    }
    return successorPlanStrategy(
      root,
      sourceCommit,
      historicalConfig,
      retailerId,
      purpose,
      version,
    );
  } catch {
    return null;
  }
}

export function sourceCommitDeclaresStrategyVersion(
  root: string,
  sourceCommit: string,
  input: {
    retailerId: string;
    purpose: "discovery" | "extraction";
    version: number;
    strategy: ReturnType<typeof parseStrategy>;
  },
): boolean {
  try {
    const historicalConfig = RetailerConfigSchema.parse(JSON.parse(execFileSync(
      "git",
      ["show", `${sourceCommit}:retailers/${input.retailerId}.json`],
      { cwd: root, encoding: "utf8" },
    )));
    const strategySha256 = strategyEvidenceSha256(input.strategy);
    if (historicalConfig.strategyVersions[input.purpose] === input.version
      && strategyEvidenceSha256(historicalConfig[input.purpose]) === strategySha256) {
      return true;
    }
    const planned = successorPlanStrategy(
      root,
      sourceCommit,
      historicalConfig,
      input.retailerId,
      input.purpose,
      input.version,
    );
    if (planned !== null
      && strategyEvidenceSha256(planned) === strategySha256) return true;
    return recoveryPlanDeclaresStrategyVersion(root, sourceCommit, historicalConfig, input)
      || recoveryChainDeclaresStrategyVersion(root, sourceCommit, historicalConfig, input);
  } catch {
    return false;
  }
}

function validateFailedValidationAttemptRegistry(
  root: string,
  database: Database.Database,
  verificationPublicKey: import("node:crypto").KeyObject | null,
): {
  attempts: number;
  invalid: number;
  missing: number;
  error: string | null;
  hashes: Array<{ path: string; sha256: string }>;
} {
  const directory = join(root, "data/validation/attempts");
  const manifestPath = join(directory, "manifest.json");
  const hashes: Array<{ path: string; sha256: string }> = [];
  if (verificationPublicKey === null || !existsSync(manifestPath)) {
    return { attempts: 0, invalid: 0, missing: 1, error: null, hashes };
  }
  try {
    if (!lstatSync(manifestPath).isFile()) throw new Error("Attempt manifest is not regular");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
      attempts?: unknown;
    };
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.attempts)) {
      throw new Error("Failed validation attempt manifest is malformed");
    }
    const actualFiles = readdirSync(directory)
      .filter((name) => name.endsWith(".json") && name !== "manifest.json")
      .map((name) => `data/validation/attempts/${name}`)
      .sort();
    const entries = manifest.attempts as Array<Record<string, unknown>>;
    const declaredFiles = entries.map((entry) => entry.path).sort();
    if (
      declaredFiles.some((path) => typeof path !== "string")
      || JSON.stringify(declaredFiles) !== JSON.stringify(actualFiles)
      || !gitSucceeds(root, ["ls-files", "--error-unmatch", "data/validation/attempts/manifest.json"])
    ) {
      throw new Error("Failed validation attempt manifest coverage is incomplete");
    }
    for (const entry of entries) {
      if (
        Object.keys(entry).sort().join("\0")
          !== ["fileSha256", "path", "receiptSha256", "strategySourceCommit"].sort().join("\0")
        || typeof entry.path !== "string"
        || !/^data\/validation\/attempts\/[a-z0-9-]+\.json$/u.test(entry.path)
        || typeof entry.fileSha256 !== "string"
        || !SHA256.test(entry.fileSha256)
        || typeof entry.receiptSha256 !== "string"
        || !SHA256.test(entry.receiptSha256)
        || typeof entry.strategySourceCommit !== "string"
        || !COMMIT.test(entry.strategySourceCommit)
        || !gitSucceeds(root, ["ls-files", "--error-unmatch", entry.path])
      ) {
        throw new Error("Failed validation attempt manifest entry is malformed");
      }
      const absolutePath = resolve(root, entry.path);
      if (!lstatSync(absolutePath).isFile()) throw new Error("Attempt receipt is not regular");
      const raw = readFileSync(absolutePath);
      if (hash(raw) !== entry.fileSha256) throw new Error("Attempt file digest mismatch");
      const parsed = StrategyValidationEvidenceSchema.parse(JSON.parse(raw.toString("utf8")));
      if (
        parsed.attempted !== 30
        || parsed.valid >= 27
        || parsed.score !== parsed.valid / parsed.attempted
        || parsed.activatable !== false
        || validationReceiptSha256(parsed) !== entry.receiptSha256
        || parsed.executor.sourceCommit !== entry.strategySourceCommit
        || !gitSucceeds(root, ["merge-base", "--is-ancestor", parsed.executor.sourceCommit, "HEAD"])
      ) {
        throw new Error("Failed validation receipt outcome is inconsistent");
      }
      let declaredStrategy = declaredStrategyAtSourceCommit(
        root,
        entry.strategySourceCommit,
        parsed.retailerId,
        parsed.purpose,
        parsed.strategyVersion,
      );
      if (declaredStrategy === null
        || strategyEvidenceSha256(declaredStrategy) !== parsed.strategySha256) {
        const recovery = committedJson(
          root,
          entry.strategySourceCommit,
          SUCCESSOR_RECOVERY_PLAN_PATH,
        ) as { schemaVersion?: unknown; plans?: unknown };
        if (recovery.schemaVersion !== 1 || !Array.isArray(recovery.plans)) {
          throw new Error(`Failed receipt recovery declaration is malformed: ${entry.path}`);
        }
        const matches = recovery.plans.filter((candidate) => {
          if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
            return false;
          }
          const value = candidate as Record<string, unknown>;
          return value.retailerId === parsed.retailerId
            && value.purpose === parsed.purpose
            && value.toVersion === parsed.strategyVersion
            && value.strategySha256 === parsed.strategySha256
            && typeof value.candidatePath === "string";
        }) as Array<Record<string, unknown>>;
        if (matches.length !== 1 || typeof matches[0]?.candidatePath !== "string") {
          throw new Error(
            `Failed receipt recovery strategy is not uniquely declared: ${entry.path}`,
          );
        }
        declaredStrategy = parseStrategy(committedJson(
          root,
          entry.strategySourceCommit,
          matches[0].candidatePath,
        ));
      }
      if (!sourceCommitDeclaresStrategyVersion(root, entry.strategySourceCommit, {
        retailerId: parsed.retailerId,
        purpose: parsed.purpose,
        version: parsed.strategyVersion,
        strategy: declaredStrategy,
      })) {
        throw new Error("Failed receipt strategy version lacks historical identity");
      }
      validateStrategyEvidence(parsed, {
        retailerId: parsed.retailerId,
        purpose: parsed.purpose,
        strategyVersion: parsed.strategyVersion,
        strategy: declaredStrategy,
        verificationPublicKey,
      });
      const activatedEvidence = database.prepare(`
        SELECT 1
        FROM strategies AS strategy
        JOIN strategy_validation_evidence AS evidence ON evidence.strategy_id = strategy.id
        WHERE strategy.retailer_id = ? AND strategy.purpose = ? AND strategy.version = ?
      `).get(parsed.retailerId, parsed.purpose, parsed.strategyVersion);
      if (activatedEvidence !== undefined) {
        throw new Error("Failed validation receipt is also registered as activation evidence");
      }
      hashes.push({ path: entry.path, sha256: entry.fileSha256 });
    }
    hashes.push({
      path: "data/validation/attempts/manifest.json",
      sha256: hash(readFileSync(manifestPath)),
    });
    return { attempts: entries.length, invalid: 0, missing: 0, error: null, hashes };
  } catch (error) {
    return {
      attempts: 0,
      invalid: 1,
      missing: 0,
      error: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
      hashes,
    };
  }
}

export function evaluateActiveStrategyValidationReceipts(
  root: string,
  database: Database.Database,
  now: Date,
): CriterionEvaluation {
  const id = "m3-active-strategy-validation-receipts";
  const rows = database.prepare(`
    SELECT id, retailer_id, purpose, version, strategy_json,
      validation_sample_size, validation_successes, validation_rate,
      validated_at, activated_at, retired_at, active, provenance
    FROM strategies
    ORDER BY retailer_id, purpose, version
  `).all() as StrategyReceiptRow[];
  const strategies = new Map(rows.map((row) => [
    `${row.retailer_id}/${row.purpose}/${row.version}`,
    row,
  ]));
  const active = rows.filter((row) => row.active === 1);
  let configs = new Map<string, RetailerConfig>();
  let configRegistryValid = true;
  try {
    configs = new Map(loadRetailerConfigs(join(root, "retailers")).map((config) => [config.id, config]));
  } catch {
    configRegistryValid = false;
  }
  const validationRoot = join(root, "data/validation");
  const files = existsSync(validationRoot)
    ? readdirSync(validationRoot).filter((name) =>
        /^[a-z0-9-]+-(?:discovery|extraction)-v[1-9]\d*\.json$/u.test(name)).sort()
    : [];
  const receipts = new Map<string, string>();
  const receiptHashes: Array<{ path: string; sha256: string }> = [];
  let malformedReceipts = 0;
  let preservedReceipts = 0;
  let untrackedReceipts = 0;
  let verificationPublicKey: import("node:crypto").KeyObject | null = null;
  let trustedValidatorArtifactSha256: string | null = null;
  try {
    verificationPublicKey = readValidationVerificationPublicKey(
      join(root, "ops/validation-attestation-public.pem"),
    );
  } catch {
    verificationPublicKey = null;
  }
  try {
    trustedValidatorArtifactSha256 = readTrustedValidatorArtifactSha256(
      join(root, "ops/validator-bundle.sha256"),
    );
  } catch {
    trustedValidatorArtifactSha256 = null;
  }
  for (const name of files) {
    const relativePath = `data/validation/${name}`;
    const path = join(validationRoot, name);
    try {
      if (!lstatSync(path).isFile()) throw new TypeError("Validation receipt is not a regular file");
      const raw = readFileSync(path);
      const parsed = StrategyValidationEvidenceSchema.parse(JSON.parse(raw.toString("utf8")));
      const key = `${parsed.retailerId}/${parsed.purpose}/${parsed.strategyVersion}`;
      const strategy = strategies.get(key);
      const expectedName = `${parsed.retailerId}-${parsed.purpose}-v${parsed.strategyVersion}.json`;
      if (name !== expectedName || receipts.has(key)) {
        throw new TypeError("Validation receipt identity is unknown, duplicated, or misnamed");
      }
      const declaredStrategy = strategy === undefined
        ? declaredStrategyAtSourceCommit(
            root,
            parsed.executor.sourceCommit,
            parsed.retailerId,
            parsed.purpose,
            parsed.strategyVersion,
          )
        : parseStrategy(strategy.strategy_json);
      if (declaredStrategy === null) {
        throw new TypeError("Validation receipt strategy is not declared by its source commit");
      }
      const receiptPublicKey = strategy === undefined
        ? createPublicKey(committedBlob(
            root,
            parsed.executor.sourceCommit,
            "ops/validation-attestation-public.pem",
          ))
        : verificationPublicKey;
      if (receiptPublicKey === null) {
        throw new TypeError("Validation verification public key is unavailable");
      }
      const authoritativeRefs = strategy?.active === 1
        ? (database.prepare(`
            SELECT canonical_url, retailer_product_id, source_category
            FROM products
            WHERE retailer_id = ?
            ORDER BY canonical_url
          `).all(strategy.retailer_id) as Array<{
            canonical_url: string;
            retailer_product_id: string | null;
            source_category: string | null;
          }>).map((ref) => ({
            canonicalUrl: ref.canonical_url,
            externalId: ref.retailer_product_id,
            sourceCategory: ref.source_category,
          }))
        : undefined;
      const validated = validateStrategyEvidence(parsed, {
        retailerId: parsed.retailerId,
        purpose: parsed.purpose,
        strategyVersion: parsed.strategyVersion,
        strategy: declaredStrategy,
        verificationPublicKey: receiptPublicKey,
        ...(authoritativeRefs === undefined ? {} : { authoritativeRefs }),
      });
      if (!gitSucceeds(root, [
        "merge-base",
        "--is-ancestor",
        validated.executor.sourceCommit,
        "HEAD",
      ])) {
        throw new TypeError(
          "Validation executor source commit is unknown or not an ancestor of HEAD",
        );
      }
      const canonicalReceiptSha256 = validationReceiptSha256(validated);
      if (strategy === undefined) {
        const sourceArtifactSha256 = committedBlob(
          root,
          validated.executor.sourceCommit,
          "ops/validator-bundle.sha256",
        ).toString("utf8").trim();
        if (!sourceCommitDeclaresStrategyVersion(root, validated.executor.sourceCommit, {
          retailerId: validated.retailerId,
          purpose: validated.purpose,
          version: validated.strategyVersion,
          strategy: declaredStrategy,
        })
          || validated.executor.artifactSha256 !== sourceArtifactSha256
          || validated.attempted !== 30
          || validated.activatable !== true
          || validated.valid < 27
          || validated.score !== validated.valid / validated.attempted
          || Date.parse(validated.validatedAt) > now.getTime()) {
          throw new TypeError("Preserved validation receipt is malformed or misbound");
        }
        if (!gitSucceeds(root, ["ls-files", "--error-unmatch", relativePath])) {
          untrackedReceipts += 1;
        }
        receipts.set(key, relativePath);
        receiptHashes.push({ path: relativePath, sha256: hash(raw) });
        preservedReceipts += 1;
        continue;
      }
      const config = configs.get(strategy.retailer_id);
      const configValidation = config?.validation[strategy.purpose];
      const configIdentityMatches = config?.active === true
        && config.strategyVersions[strategy.purpose] === strategy.version
        && JSON.stringify(config[strategy.purpose]) === strategy.strategy_json;
      const generatedActivationExists = strategy.provenance === "Codex SDK; trusted host validation"
        && database.prepare(`
          SELECT 1 FROM exploration_runs
          WHERE candidate_strategy_id = ? AND retailer_id = ? AND purpose = ?
            AND status = 'finished' AND outcome = 'activated'
          LIMIT 1
        `).get(strategy.id, strategy.retailer_id, strategy.purpose) !== undefined;
      if (strategy.active === 1 && !generatedActivationExists
        && !sourceCommitDeclaresStrategyVersion(root, validated.executor.sourceCommit, {
          retailerId: strategy.retailer_id,
          purpose: strategy.purpose,
          version: strategy.version,
          strategy: parseStrategy(strategy.strategy_json),
        })) {
        throw new TypeError("Validation executor source does not declare the strategy version");
      }
      if (strategy.active === 1 && !configIdentityMatches && !generatedActivationExists) {
        throw new TypeError("Validation receipt does not bind a config or trusted generated activation");
      }
      if (strategy.active === 1 && configIdentityMatches
        && (configValidation?.externallyValidated !== true
          || configValidation.sampleSize !== strategy.validation_sample_size
          || configValidation.successes !== strategy.validation_successes
          || configValidation.score !== strategy.validation_rate
          || configValidation.validatedAt !== strategy.validated_at
          || configValidation.receiptPath !== relativePath
          || configValidation.receiptSha256 !== canonicalReceiptSha256)) {
        throw new TypeError("Validation receipt does not bind the active retailer config aggregate");
      }
      const lifecycleValid = strategy.active === 1
        ? strategy.activated_at !== null && strategy.retired_at === null
        : strategy.activated_at !== null
          && strategy.retired_at !== null
          && Date.parse(strategy.retired_at) >= Date.parse(strategy.activated_at);
      const validationLifecycleValid = strategy.active === 1
        ? strategy.activated_at !== null
          && Date.parse(strategy.activated_at) >= Date.parse(validated.validatedAt)
        : strategy.retired_at !== null
          && Date.parse(strategy.retired_at) >= Date.parse(validated.validatedAt);
      const activeArtifactBindingValid = strategy.active !== 1 || (
        trustedValidatorArtifactSha256 !== null
        && validated.executor.artifactSha256 === trustedValidatorArtifactSha256
        && validated.executor.challengeAlgorithm
          === "active-in-scope-category-url-bucket-round-robin-v1"
      );
      if (validated.attempted !== 30 || validated.activatable !== true
        || validated.valid !== strategy.validation_successes
        || validated.attempted !== strategy.validation_sample_size
        || strategy.validation_rate === null
        || validated.score !== strategy.validation_rate
        || validated.validatedAt !== strategy.validated_at
        || !lifecycleValid
        || !validationLifecycleValid
        || !activeArtifactBindingValid
        || strategy.activated_at === null
        || Date.parse(validated.validatedAt) > now.getTime()) {
        throw new TypeError("Validation receipt does not bind the database activation aggregate");
      }
      const immutable = database.prepare(`
        SELECT receipt_path, receipt_sha256, sample_set_sha256, executor_json,
               attestation_key_id, attempted, valid, score, validated_at
        FROM strategy_validation_evidence WHERE strategy_id = ?
      `).get(strategy.id) as {
        receipt_path: string;
        receipt_sha256: string;
        sample_set_sha256: string;
        executor_json: string;
        attestation_key_id: string;
        attempted: number;
        valid: number;
        score: number;
        validated_at: string;
      } | undefined;
      if (
        immutable === undefined
        || immutable.receipt_path !== relativePath
        || immutable.receipt_sha256 !== canonicalReceiptSha256
        || immutable.sample_set_sha256 !== validated.sampleSetSha256
        || immutable.executor_json !== JSON.stringify(validated.executor)
        || immutable.attestation_key_id !== validated.attestation.keyId
        || immutable.attempted !== validated.attempted
        || immutable.valid !== validated.valid
        || immutable.score !== validated.score
        || immutable.validated_at !== validated.validatedAt
      ) {
        throw new TypeError("Validation receipt does not bind immutable database evidence");
      }
      if (!gitSucceeds(root, ["ls-files", "--error-unmatch", relativePath])) {
        untrackedReceipts += 1;
      }
      receipts.set(key, relativePath);
      receiptHashes.push({ path: relativePath, sha256: hash(raw) });
    } catch {
      malformedReceipts += 1;
    }
  }
  const missingActiveReceipts = active.filter((row) =>
    !receipts.has(`${row.retailer_id}/${row.purpose}/${row.version}`)).length;
  const failedAttempts = validateFailedValidationAttemptRegistry(
    root,
    database,
    verificationPublicKey,
  );
  const malformedReceiptFiles = malformedReceipts;
  receiptHashes.push(...failedAttempts.hashes);
  const registrySha256 = receiptHashes.length === 0 ? undefined : hash(receiptHashes
    .sort((left, right) => left.path.localeCompare(right.path, "en"))
    .map((item) => `${item.path}\0${item.sha256}\n`).join(""));
  const evidenceId = "file-m3-active-strategy-validation-receipts";
  const item = evidence(evidenceId, "file", "data/validation", now.toISOString(), {
    activeStrategies: active.length,
    receiptFiles: files.length,
    validReceipts: receipts.size,
    preservedReceipts,
    missingActiveReceipts,
    malformedReceipts,
    untrackedReceipts,
    configRegistryValid,
    preservedFailedAttempts: failedAttempts.attempts,
    failedAttemptRegistryInvalid: failedAttempts.invalid,
    failedAttemptRegistryError: failedAttempts.error,
    failedAttemptRegistryMissing: failedAttempts.missing,
  }, registrySha256);
  if (active.length === 0) {
    return {
      criterion: criterion(id, "fail", "No active strategy exists to validate", ["UNSAFE_CONFIGURATION"], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  if (malformedReceiptFiles > 0) {
    return {
      criterion: criterion(id, "fail", "The strategy-validation receipt registry is malformed or misbound", ["EVIDENCE_CONTRADICTION"], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  if (missingActiveReceipts > 0 || failedAttempts.missing > 0) {
    return {
      criterion: criterion(id, "fail", "One or more active strategies lack a machine-readable 30-sample validation receipt", ["REQUIRED_ARTIFACT_MISSING"], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  if (failedAttempts.invalid > 0) {
    return {
      criterion: criterion(id, "fail", "The strategy-validation receipt registry is malformed or misbound", ["EVIDENCE_CONTRADICTION"], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  if (!configRegistryValid || untrackedReceipts > 0) {
    return {
      criterion: criterion(id, "fail", "Strategy-validation receipts are not bound to the published retailer config registry", ["EVIDENCE_CONTRADICTION"], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  return {
    criterion: criterion(id, "pass", "Every active strategy has a published, identity-bound 30-sample validation receipt", [], [evidenceId]),
    gates: [],
    evidence: [item],
  };
}

export interface M4GateOptions {
  credentialConfigured: boolean;
  spendAuthorized: boolean;
  siteValidated: boolean;
}

export function evaluateM4(
  database: Database.Database,
  options: M4GateOptions,
  now: Date,
): CriterionEvaluation {
  const id = "m4-live-agent-strategies";
  const activeRetailers = (database.prepare("SELECT COUNT(*) AS count FROM retailers WHERE active = 1").get() as { count: number }).count;
  const rows = database.prepare(`
    WITH purposes(purpose) AS (VALUES ('discovery'), ('extraction'))
    SELECT retailer.id AS retailer_id, purpose.purpose,
      strategy.id AS strategy_id, strategy.model, strategy.prompt_version,
      strategy.version AS strategy_version,
      strategy.provenance, strategy.activated_at,
      strategy.validation_sample_size, strategy.validation_rate,
      exploration.id AS exploration_run_id,
      exploration.retailer_id AS exploration_retailer_id,
      exploration.purpose AS exploration_purpose,
      exploration.previous_strategy_id,
      exploration.status AS exploration_status,
      exploration.finished_at AS exploration_finished_at,
      exploration.outcome AS exploration_outcome,
      exploration.input_tokens AS exploration_input_tokens,
      exploration.output_tokens AS exploration_output_tokens,
      exploration.cost_usd AS exploration_cost_usd,
      (SELECT SUM(all_attempt.input_tokens) FROM exploration_attempts AS all_attempt WHERE all_attempt.exploration_run_id = exploration.id) AS attempt_input_total,
      (SELECT SUM(all_attempt.output_tokens) FROM exploration_attempts AS all_attempt WHERE all_attempt.exploration_run_id = exploration.id) AS attempt_output_total,
      (SELECT SUM(all_attempt.cost_usd) FROM exploration_attempts AS all_attempt WHERE all_attempt.exploration_run_id = exploration.id) AS attempt_cost_total,
      (SELECT SUM(all_ledger.input_tokens) FROM cost_ledger AS all_ledger WHERE all_ledger.exploration_run_id = exploration.id AND all_ledger.category = 'strategy-exploration') AS ledger_input_total,
      (SELECT SUM(all_ledger.output_tokens) FROM cost_ledger AS all_ledger WHERE all_ledger.exploration_run_id = exploration.id AND all_ledger.category = 'strategy-exploration') AS ledger_output_total,
      (SELECT SUM(all_ledger.cost_usd) FROM cost_ledger AS all_ledger WHERE all_ledger.exploration_run_id = exploration.id AND all_ledger.category = 'strategy-exploration') AS ledger_cost_total,
      previous.retailer_id AS previous_retailer_id,
      previous.purpose AS previous_purpose,
      previous.version AS previous_version,
      previous.active AS previous_active,
      previous.retired_at AS previous_retired_at,
      attempt.attempt_number, attempt.prompt_hash, attempt.external_sample_size,
      attempt.external_successes, attempt.external_score, attempt.input_tokens,
      attempt.cached_input_tokens, attempt.output_tokens, attempt.reasoning_output_tokens,
      attempt.cost_usd, attempt.cost_estimated, attempt.estimate_source,
      attempt.rate_version, attempt.model AS attempt_model,
      attempt.prompt_version AS attempt_prompt_version,
      attempt.created_at AS attempt_created_at,
      attempt.outcome AS attempt_outcome,
      reservation.id AS reservation_id, reservation.status AS reservation_status,
      reservation.category AS reservation_category,
      reservation.retailer_id AS reservation_retailer_id,
      reservation.exploration_run_id AS reservation_exploration_run_id,
      reservation.amount_usd AS reservation_amount_usd,
      reservation.actual_cost_usd AS reservation_actual_cost_usd,
      ledger.id AS ledger_id, ledger.category AS ledger_category,
      ledger.retailer_id AS ledger_retailer_id,
      ledger.exploration_run_id AS ledger_exploration_run_id,
      ledger.provider AS ledger_provider,
      ledger.model AS ledger_model, ledger.input_tokens AS ledger_input_tokens,
      ledger.output_tokens AS ledger_output_tokens, ledger.cost_usd AS ledger_cost_usd,
      ledger.occurred_at AS ledger_occurred_at,
      json_extract(ledger.details_json, '$.cachedInputTokens') AS ledger_cached_input_tokens,
      json_extract(ledger.details_json, '$.reasoningOutputTokens') AS ledger_reasoning_output_tokens,
      json_extract(ledger.details_json, '$.costEstimated') AS ledger_cost_estimated,
      json_extract(ledger.details_json, '$.estimateSource') AS ledger_estimate_source,
      json_extract(ledger.details_json, '$.rateVersion') AS ledger_rate_version,
      json_extract(ledger.details_json, '$.promptHash') AS ledger_prompt_hash
    FROM retailers AS retailer
    CROSS JOIN purposes AS purpose
    LEFT JOIN strategies AS strategy ON strategy.retailer_id = retailer.id
      AND strategy.purpose = purpose.purpose AND strategy.active = 1
    LEFT JOIN exploration_runs AS exploration ON exploration.candidate_strategy_id = strategy.id
      AND exploration.outcome = 'activated'
    LEFT JOIN strategies AS previous ON previous.id = exploration.previous_strategy_id
    LEFT JOIN exploration_attempts AS attempt ON attempt.exploration_run_id = exploration.id
      AND attempt.outcome = 'activated'
    LEFT JOIN model_budget_reservations AS reservation ON reservation.exploration_run_id = exploration.id
      AND reservation.status IN ('settled', 'released')
    LEFT JOIN cost_ledger AS ledger ON ledger.exploration_run_id = exploration.id
      AND json_extract(ledger.details_json, '$.attemptNumber') = attempt.attempt_number
    WHERE retailer.active = 1
    ORDER BY retailer.id, purpose.purpose, attempt.attempt_number
  `).all() as Array<Record<string, unknown>>;
  const validRows = rows.filter((row) =>
    typeof row.strategy_id === "string"
    && typeof row.model === "string"
    && typeof row.prompt_version === "string"
    && row.provenance === "Codex SDK; trusted host validation"
    && typeof row.activated_at === "string"
    && typeof row.strategy_version === "number" && Number.isSafeInteger(row.strategy_version)
    && row.validation_sample_size === 30
    && typeof row.validation_rate === "number" && Number.isFinite(row.validation_rate) && row.validation_rate >= 0.9
    && row.exploration_outcome === "activated"
    && row.exploration_status === "finished"
    && row.exploration_retailer_id === row.retailer_id
    && row.exploration_purpose === row.purpose
    && typeof row.exploration_finished_at === "string"
    && Date.parse(String(row.exploration_finished_at)) >= Date.parse(String(row.activated_at))
    && typeof row.previous_strategy_id === "string"
    && row.previous_retailer_id === row.retailer_id
    && row.previous_purpose === row.purpose
    && typeof row.previous_version === "number"
    && Number(row.previous_version) < Number(row.strategy_version)
    && row.previous_active === 0
    && row.previous_retired_at === row.activated_at
    && typeof row.prompt_hash === "string"
    && /^[a-f0-9]{64}$/u.test(row.prompt_hash)
    && row.attempt_model === row.model
    && row.attempt_prompt_version === row.prompt_version
    && typeof row.input_tokens === "number" && Number.isSafeInteger(row.input_tokens) && row.input_tokens >= 0
    && typeof row.cached_input_tokens === "number" && Number.isSafeInteger(row.cached_input_tokens) && row.cached_input_tokens >= 0
    && typeof row.output_tokens === "number" && Number.isSafeInteger(row.output_tokens) && row.output_tokens >= 0
    && typeof row.reasoning_output_tokens === "number" && Number.isSafeInteger(row.reasoning_output_tokens) && row.reasoning_output_tokens >= 0
    && Number(row.input_tokens) + Number(row.output_tokens) > 0
    && typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd) && row.cost_usd >= 0
    && typeof row.exploration_input_tokens === "number" && Number.isSafeInteger(row.exploration_input_tokens)
    && typeof row.exploration_output_tokens === "number" && Number.isSafeInteger(row.exploration_output_tokens)
    && typeof row.exploration_cost_usd === "number" && Number.isFinite(row.exploration_cost_usd)
    && row.exploration_input_tokens === row.attempt_input_total
    && row.exploration_output_tokens === row.attempt_output_total
    && row.exploration_cost_usd === row.attempt_cost_total
    && row.exploration_input_tokens === row.ledger_input_total
    && row.exploration_output_tokens === row.ledger_output_total
    && row.exploration_cost_usd === row.ledger_cost_total
    && (row.cost_estimated === 0 || row.cost_estimated === 1)
    && typeof row.estimate_source === "string" && row.estimate_source !== ""
    && typeof row.rate_version === "string" && row.rate_version !== ""
    && row.external_sample_size === 30
    && typeof row.external_successes === "number" && row.external_successes >= 27
    && typeof row.external_score === "number" && Number.isFinite(row.external_score) && row.external_score >= 0.9
    && row.attempt_outcome === "activated"
    && typeof row.reservation_id === "string"
    && row.reservation_category === "strategy-exploration"
    && row.reservation_retailer_id === row.retailer_id
    && row.reservation_exploration_run_id === row.exploration_run_id
    && row.reservation_status === "settled"
    && typeof row.reservation_amount_usd === "number"
    && Number.isFinite(row.reservation_amount_usd)
    && Number(row.reservation_amount_usd) >= Number(row.reservation_actual_cost_usd)
    && Number(row.reservation_amount_usd) <= 5
    && typeof row.reservation_actual_cost_usd === "number" && Number.isFinite(row.reservation_actual_cost_usd)
    && row.reservation_actual_cost_usd === row.exploration_cost_usd
    && typeof row.ledger_id === "string"
    && row.ledger_category === "strategy-exploration"
    && row.ledger_retailer_id === row.retailer_id
    && row.ledger_exploration_run_id === row.exploration_run_id
    && row.ledger_provider === "codex-sdk"
    && row.ledger_model === row.model
    && typeof row.ledger_input_tokens === "number" && row.ledger_input_tokens === row.input_tokens
    && typeof row.ledger_output_tokens === "number" && row.ledger_output_tokens === row.output_tokens
    && typeof row.ledger_cost_usd === "number" && Number.isFinite(row.ledger_cost_usd) && row.ledger_cost_usd === row.cost_usd
    && row.ledger_occurred_at === row.attempt_created_at
    && row.ledger_cached_input_tokens === row.cached_input_tokens
    && row.ledger_reasoning_output_tokens === row.reasoning_output_tokens
    && row.ledger_cost_estimated === row.cost_estimated
    && row.ledger_estimate_source === row.estimate_source
    && row.ledger_rate_version === row.rate_version
    && row.ledger_prompt_hash === row.prompt_hash
  );
  const validPairCounts = new Map<string, number>();
  for (const row of validRows) {
    const pair = `${String(row.retailer_id)}/${String(row.purpose)}`;
    validPairCounts.set(pair, (validPairCounts.get(pair) ?? 0) + 1);
  }
  const validPairs = new Set([...validPairCounts]
    .filter(([, count]) => count === 1)
    .map(([pair]) => pair));
  const activatedRows = rows.filter((row) => typeof row.exploration_run_id === "string"
    && row.exploration_outcome === "activated");
  const malformedActivatedRows = activatedRows.length - validRows.length;
  const duplicateActivatedPairs = [...validPairCounts.values()].filter((count) => count !== 1).length;
  const requiredPairs = activeRetailers * 2;
  const evidenceId = "db-m4-agent-activated-strategies";
  const resultEvidence = evidence(evidenceId, "database-query", "m4-agent-activated-strategies", now.toISOString(), {
    activeRetailers,
    requiredPurposePairs: requiredPairs,
    qualifyingPurposePairs: validPairs.size,
    malformedActivatedRows,
    duplicateActivatedPairs,
    credentialGateConfigured: options.credentialConfigured,
    liveSpendAuthorized: options.spendAuthorized,
  });
  if (malformedActivatedRows > 0 || duplicateActivatedPairs > 0) {
    return {
      criterion: criterion(id, "fail", "Activated exploration evidence is malformed, misbound, or duplicated", ["EVIDENCE_CONTRADICTION"], [evidenceId]),
      gates: [],
      evidence: [resultEvidence],
    };
  }
  if (requiredPairs > 0 && validPairs.size === requiredPairs) {
    return { criterion: criterion(id, "pass", "Every active retailer/purpose has immutable activated agent evidence and cost accounting", [], [evidenceId]), gates: [], evidence: [resultEvidence] };
  }
  let kind: PendingGateKind = "site";
  let reason = "SITE_VALIDATION_PENDING";
  let action = "Obtain 30 honest external references for each remaining retailer/purpose";
  if (!options.credentialConfigured) {
    kind = "credential";
    reason = "CREDENTIAL_NOT_CONFIGURED";
    action = "Configure the model credential privately; acceptance will not invoke the provider";
  } else if (!options.spendAuthorized) {
    kind = "authority";
    reason = "LIVE_SPEND_NOT_AUTHORIZED";
    action = "The author must explicitly opt in with LIVE_OPENAI=1 before the normal exploration workflow";
  } else if (options.siteValidated) {
    return { criterion: criterion(id, "fail", "Authorized available live evidence is incomplete or below the 27/30 threshold", ["EVIDENCE_CONTRADICTION"], [evidenceId]), gates: [], evidence: [resultEvidence] };
  }
  return {
    criterion: criterion(id, "pending", "Live strategy generation remains externally gated; acceptance made no provider call", [reason], [evidenceId]),
    gates: [gate(id, kind, reason, null, action, "npm run acceptance -- --json", [evidenceId])],
    evidence: [resultEvidence],
  };
}

function commandAcceptance(id: string, command: CommandEvidence, summary: string): CriterionEvaluation {
  const evidenceId = `command-${command.id}`;
  const item = evidence(evidenceId, "command", command.id, command.finishedAt, {
    exitCode: command.exitCode,
    startedAt: command.startedAt,
    finishedAt: command.finishedAt,
    ...command.facts,
  }, command.outputSha256);
  return {
    criterion: criterion(id, command.exitCode === 0 ? "pass" : "fail", summary,
      command.exitCode === 0 ? [] : ["OFFLINE_CHECK_FAILED"], [evidenceId]),
    gates: [],
    evidence: [item],
  };
}

export interface M5HealingDrillGateOptions {
  root: string;
  evaluatedCommit: string;
  now: Date;
  credentialConfigured: boolean;
  spendAuthorized: boolean;
  installation: SystemdInstallationState;
  receiptExists?: boolean;
  validateReceipt?: () => HealingSabotageDrillReceipt;
}

export function evaluateM5HealingDrill(
  options: M5HealingDrillGateOptions,
): CriterionEvaluation {
  const id = "m5-automatic-healing";
  const relativePath = "data/acceptance/evidence/healing-sabotage-drill.json";
  const receiptPath = join(options.root, relativePath);
  const receiptExists = options.receiptExists ?? existsSync(receiptPath);
  const releaseSourceCurrent = options.installation.sourceCommit !== null
    && (options.installation.sourceCommit === options.evaluatedCommit
      || releaseSourceMatchesEvaluatedCommit(
        options.root,
        options.installation.sourceCommit,
        options.evaluatedCommit,
      ));
  let receipt: HealingSabotageDrillReceipt | null = null;
  let invalid = false;
  if (receiptExists) {
    try {
      if (options.validateReceipt !== undefined) {
        receipt = options.validateReceipt();
      } else {
        if (options.installation.releasePath === null
          || options.installation.releaseId === null
          || options.installation.sourceCommit === null) {
          throw new Error("Current installed release identity is absent");
        }
        receipt = validateHealingSabotageEvidence({
          projectRoot: options.root,
          releasePath: options.installation.releasePath,
          publicKeyPath: join(options.root, "ops/validation-attestation-public.pem"),
          receiptPath,
          expectedSourceCommit: options.installation.sourceCommit,
          expectedReleaseId: options.installation.releaseId,
          now: options.now,
        });
      }
    } catch {
      invalid = true;
    }
    if (receipt !== null) {
      try {
        assertHealingSabotageReceiptFresh(receipt, options.now);
        if (receipt.payload.release.sourceCommit !== options.installation.sourceCommit
          || receipt.payload.release.releaseId !== options.installation.releaseId) {
          throw new Error("Healing receipt is bound to a different release");
        }
      } catch {
        invalid = true;
      }
    }
  }
  const evidenceId = "receipt-m5-installed-release-healing-sabotage";
  const receiptHash = receiptExists
    ? (() => {
        try {
          return hash(readFileSync(receiptPath));
        } catch {
          return receipt?.signature.payloadSha256;
        }
      })()
    : undefined;
  const item = evidence(
    evidenceId,
    "receipt",
    relativePath,
    receipt?.payload.observedAt ?? options.now.toISOString(),
    {
      receiptPresent: receiptExists,
      receiptValid: receipt !== null && !invalid,
      installedReleaseValid: options.installation.valid,
      installedReleaseCurrent: releaseSourceCurrent,
      credentialConfigured: options.credentialConfigured,
      liveSpendAuthorized: options.spendAuthorized,
      releaseId: receipt?.payload.release.releaseId ?? null,
      sourceCommit: receipt?.payload.release.sourceCommit ?? null,
      brokenAttempted: receipt?.payload.brokenRun.attempted ?? 0,
      brokenSuccessRate: receipt?.payload.brokenRun.successRate ?? 0,
      healingAttempts: receipt?.payload.healing.attempts ?? 0,
      modelInputTokens: receipt?.payload.cost.inputTokens ?? 0,
      modelOutputTokens: receipt?.payload.cost.outputTokens ?? 0,
      modelCostUsd: receipt?.payload.cost.actualCostUsd ?? 0,
      validationSampleSize: receipt?.payload.validation.attempted ?? 0,
      validationSuccesses: receipt?.payload.validation.valid ?? 0,
      recoveredSuccessRate: receipt?.payload.recoveredRun.successRate ?? 0,
    },
    receiptHash,
  );
  if (!options.installation.valid
    || !releaseSourceCurrent
    || options.installation.releasePath === null
    || options.installation.releaseId === null) {
    return {
      criterion: criterion(id, "fail", "M5 requires a current valid installed frozen release", ["UNSAFE_CONFIGURATION"], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  if (receiptExists && (invalid || receipt === null)) {
    return {
      criterion: criterion(id, "fail", "The installed-release healing sabotage receipt is malformed, stale, or misbound", ["EVIDENCE_CONTRADICTION"], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  if (receipt !== null) {
    return {
      criterion: criterion(id, "pass", "A credential-backed installed-release staging sabotage healed and recovered without human intervention", [], [evidenceId]),
      gates: [],
      evidence: [item],
    };
  }
  let kind: PendingGateKind;
  let reason: string;
  let action: string;
  if (!options.credentialConfigured) {
    kind = "credential";
    reason = "CREDENTIAL_NOT_CONFIGURED";
    action = "Configure the explorer credential privately; acceptance will not invoke a provider";
  } else if (!options.spendAuthorized) {
    kind = "authority";
    reason = "LIVE_SPEND_NOT_AUTHORIZED";
    action = "Set LIVE_OPENAI=1 only after explicitly authorizing the bounded staging drill spend";
  } else {
    kind = "site";
    reason = "SITE_VALIDATION_PENDING";
    action = "Run the isolated installed-release staging sabotage and retain its signed evidence";
  }
  return {
    criterion: criterion(id, "pending", "Offline healing checks pass only as supporting evidence; the genuine staging sabotage drill is still pending", [reason], [evidenceId]),
    gates: [gate(
      id,
      kind,
      reason,
      null,
      action,
      "npm run acceptance:healing-drill -- --confirm-staging-sabotage --authorize-live-spend-usd 5",
      [evidenceId],
    )],
    evidence: [item],
  };
}

export function sourceWorktreeClean(root: string): boolean {
  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
  } catch {
    return false;
  }
  if (porcelain === "") return true;
  return porcelain.split(/\r?\n/u).every((line) => {
    const raw = line.slice(3);
    return raw.split(" -> ").every(allowedEvidencePath);
  });
}

export function scheduledWindowIsPending(input: {
  now: Date;
  deadline: Date;
  evidenceSatisfied: boolean;
  serviceActive: boolean;
}): boolean {
  return input.serviceActive
    || (input.now.getTime() < input.deadline.getTime() && !input.evidenceSatisfied);
}

function m1Inventory(root: string, now: Date): AcceptanceEvidence {
  const requiredFiles = [
    "tests/normalize/brl.test.ts",
    "tests/normalize/unit.test.ts",
    "tests/normalize/url.test.ts",
    "tests/strategies/schema.test.ts",
    "tests/strategies/validate.test.ts",
    "tests/collection/api.test.ts",
    "tests/collection/embedded-json.test.ts",
    "tests/collection/dom.test.ts",
    "tests/collection/script.test.ts",
    "tests/collection/browser-security.test.ts",
    "tests/retailers/config.test.ts",
  ];
  const retailerRoot = join(root, "retailers");
  const retailerConfigs = existsSync(retailerRoot)
    ? readdirSync(retailerRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(retailerRoot, entry.name))
    : [];
  const mutationPaths: string[] = [];
  let fixtureBindingsComplete = retailerConfigs.length > 0;
  for (const path of retailerConfigs) {
    const config = readJson(path) as { fixtureProvenance?: unknown } | null;
    const provenance = Array.isArray(config?.fixtureProvenance)
      ? config.fixtureProvenance as Array<Record<string, unknown>>
      : [];
    const mutations = provenance.filter((fixture) => fixture.synthetic === true
      && typeof fixture.path === "string"
      && /(?:^|\/)mutated-product\.(?:html|json)$/u.test(fixture.path));
    if (mutations.length !== 1) fixtureBindingsComplete = false;
    for (const mutation of mutations) {
      const relative = mutation.path as string;
      mutationPaths.push(relative);
      const absolute = resolve(root, relative);
      if (!absolute.startsWith(`${root}${sep}`)
        || !existsSync(absolute)
        || !/synthetic/iu.test(readFileSync(absolute, "utf8"))) {
        fixtureBindingsComplete = false;
      }
    }
  }
  if (new Set(mutationPaths).size !== mutationPaths.length) fixtureBindingsComplete = false;
  const retailerRegressionPath = join(root, "tests/retailers/config.test.ts");
  const mutationRegressionPresent = existsSync(retailerRegressionPath)
    && /classifies every retailer mutation as extraction drift/u.test(
      readFileSync(retailerRegressionPath, "utf8"),
    );
  return evidence("file-m1-fixture-inventory", "file", "tests/fixtures", now.toISOString(), {
    requiredOfflineTestFiles: requiredFiles.length,
    requiredOfflineTestFilesPresent: requiredFiles.filter((path) => existsSync(join(root, path))).length,
    retailerConfigs: retailerConfigs.length,
    mutatedRetailerFixtures: mutationPaths.length,
    fixtureBindingsComplete,
    mutationRegressionPresent,
    inventoryComplete: requiredFiles.every((path) => existsSync(join(root, path)))
      && fixtureBindingsComplete
      && mutationRegressionPresent,
  });
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

interface ReviewFindingState {
  valid: boolean;
  total: number;
  openCriticalOrImportant: number;
  evidence: AcceptanceEvidence;
}

export function reviewFindingState(
  root: string,
  milestone: "M5" | "M6" | "M7",
  now: Date,
): ReviewFindingState {
  const relativePath = "ops/review-findings.json";
  const path = join(root, relativePath);
  let valid = gitSucceeds(root, ["ls-files", "--error-unmatch", relativePath]);
  let findings: Array<Record<string, unknown>> = [];
  const parsed = readJson(path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || !exactObjectKeys(parsed as Record<string, unknown>, ["findings", "schemaVersion"])
    || (parsed as Record<string, unknown>).schemaVersion !== 1
    || !Array.isArray((parsed as Record<string, unknown>).findings)) {
    valid = false;
  } else {
    findings = (parsed as { findings: Array<Record<string, unknown>> }).findings;
  }
  const ids = new Set<string>();
  for (const finding of findings) {
    const resolved = finding.status === "resolved";
    if (typeof finding !== "object" || finding === null || Array.isArray(finding)
      || !exactObjectKeys(finding, ["fixCommit", "id", "milestone", "severity", "status"])
      || typeof finding.id !== "string" || finding.id === "" || ids.has(finding.id)
      || !/^M[0-7]$/u.test(String(finding.milestone))
      || !["critical", "important", "minor"].includes(String(finding.severity))
      || !["open", "resolved"].includes(String(finding.status))
      || (resolved && (typeof finding.fixCommit !== "string" || !COMMIT.test(finding.fixCommit)
        || !gitSucceeds(root, ["merge-base", "--is-ancestor", finding.fixCommit, "HEAD"])))
      || (!resolved && finding.fixCommit !== null)) {
      valid = false;
    }
    if (typeof finding.id === "string") ids.add(finding.id);
  }
  // M7 is the final cross-milestone publication gate, so it also closes review
  // findings discovered against earlier milestones. M5 and M6 retain their
  // narrower local gates for faster diagnosis.
  const scoped = milestone === "M7"
    ? findings
    : findings.filter((finding) => finding.milestone === milestone);
  const openCriticalOrImportant = scoped.filter((finding) => finding.status === "open"
    && (finding.severity === "critical" || finding.severity === "important")).length;
  const evidenceId = `file-${milestone.toLowerCase()}-review-findings`;
  return {
    valid,
    total: scoped.length,
    openCriticalOrImportant,
    evidence: evidence(evidenceId, "file", relativePath, now.toISOString(), {
      registryValid: valid,
      scopedFindings: scoped.length,
      openCriticalOrImportant,
    }, existsSync(path) ? hash(readFileSync(path)) : undefined),
  };
}

function readDrillReceipt(path: string, expectedDrill: "alert" | "backup"): PublicDrillReceipt | null {
  const value = readJson(path);
  try {
    return validatePublicDrillReceipt(value, expectedDrill);
  } catch {
    return null;
  }
}

function commandEvidenceToAcceptance(command: CommandEvidence): AcceptanceEvidence {
  return evidence(`command-${command.id}`, "command", command.id, command.finishedAt, {
    exitCode: command.exitCode,
    startedAt: command.startedAt,
    finishedAt: command.finishedAt,
    ...command.facts,
  }, command.outputSha256);
}

function m0Evaluation(
  root: string,
  database: Database.Database,
  evaluatedCommit: string,
  now: Date,
  sourceClean: boolean,
): CriterionEvaluation {
  const id = "m0-foundation-reproducibility";
  const receiptPath = join(root, "data/acceptance/evidence/fresh-clone.json");
  let receiptValid = false;
  let receiptRuntimeValid = false;
  let receiptArtifactsValid = false;
  let receiptHash: string | undefined;
  if (existsSync(receiptPath)) {
    try {
      const receipt = validateFreshCloneReceipt(readJson(receiptPath));
      receiptValid = receipt.sourceCommit === evaluatedCommit;
      receiptRuntimeValid = /^v24\./u.test(receipt.runtimes.node)
        && /^11\./u.test(receipt.runtimes.npm)
        && ["setup", "smoke", "publication", "analysis"].every((id) =>
          receipt.checks.some((check) => check.id === id && check.exitCode === 0));
      const expectedArtifacts = [
        ["analysis/output/latest.json", "analysis/output"],
        ["data/exports/latest.json", "data/exports"],
      ].map(([latest, base]) => {
        const pointer = readJson(join(root, latest ?? "")) as { snapshotDirectory?: string } | null;
        return pointer?.snapshotDirectory === undefined ? "" : `${base}/${pointer.snapshotDirectory}/manifest.json`;
      }).sort();
      const actualArtifacts = receipt.artifacts.map((artifact) => artifact.path).sort();
      receiptArtifactsValid = actualArtifacts.join("\0") === expectedArtifacts.join("\0")
        && receipt.artifacts.every((artifact) => {
          const path = resolve(root, artifact.path);
          return path.startsWith(`${root}${sep}`) && existsSync(path) && hash(readFileSync(path)) === artifact.sha256;
        });
      receiptHash = hash(readFileSync(receiptPath));
    } catch {
      receiptValid = false;
    }
  }
  const quick = database.pragma("quick_check") as Array<Record<string, unknown>>;
  const quickOk = quick.length === 1 && Object.values(quick[0] ?? {})[0] === "ok";
  const foreignKeys = (database.pragma("foreign_key_check") as unknown[]).length;
  const migrationRows = database.prepare(
    "SELECT version, name FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number; name: string }>;
  const migrations = migrationRows.length;
  const migrationsExact = JSON.stringify(migrationRows)
    === JSON.stringify(EXPECTED_SCHEMA_MIGRATIONS);
  const runtimeOk = Number(process.versions.node.split(".")[0]) === 24;
  const evidenceId = "receipt-m0-fresh-clone";
  const item = evidence(evidenceId, "receipt", "data/acceptance/evidence/fresh-clone.json", now.toISOString(), {
    receiptPresent: existsSync(receiptPath),
    receiptMatchesEvaluatedCommit: receiptValid,
    declaredRuntimesAndChecksValid: receiptRuntimeValid,
    generatedManifestArtifactsValid: receiptArtifactsValid,
    nodeMajor24: runtimeOk,
    databaseQuickCheck: quickOk ? "ok" : "failed",
    foreignKeyViolations: foreignKeys,
    migrationCount: migrations,
    migrationSetExact: migrationsExact,
    sourceWorktreeClean: sourceClean,
  }, receiptHash);
  const passed = receiptValid && receiptRuntimeValid && receiptArtifactsValid
    && runtimeOk && quickOk && foreignKeys === 0 && migrationsExact && sourceClean;
  return {
    criterion: criterion(id, passed ? "pass" : "fail", passed
      ? "Clean-clone receipt, declared runtime, migrations, and read-only database checks pass"
      : "Foundation or clean-clone reproducibility evidence is missing or invalid",
    passed ? [] : [receiptValid ? "DATABASE_INTEGRITY_FAILED" : "REQUIRED_ARTIFACT_MISSING"], [evidenceId]),
    gates: [],
    evidence: [item],
  };
}

export interface ExperimentalSeriesState {
  valid: boolean;
  nonempty: boolean;
  productRelativeRows: number;
  retailerSubitemRows: number;
  subitemRows: number;
  aggregateDailyRows: number;
  analysisAggregateDailyRows: number;
}

export function csvDataRowCount(path: string): number | null {
  try {
    const rows = parse(readFileSync(path), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
    }) as Array<Record<string, string>>;
    return rows.length;
  } catch {
    return null;
  }
}

export function csvOverlapRowCount(path: string): number | null {
  try {
    const rows = parse(readFileSync(path), {
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    return rows.filter((row) =>
      row.status === "overlap"
      && row.experimental_variation_pct !== ""
      && Number.isFinite(Number(row.experimental_variation_pct))
      && row.official_variation_pct !== ""
      && Number.isFinite(Number(row.official_variation_pct))).length;
  } catch {
    return null;
  }
}

function manifestRows(manifest: Record<string, unknown>, key: "files" | "inputs", path: string): number | null {
  const entries = manifest[key];
  if (!Array.isArray(entries)) return null;
  const matches = entries.filter((entry) => typeof entry === "object" && entry !== null
    && (entry as Record<string, unknown>).path === path);
  if (matches.length !== 1) return null;
  const rows = (matches[0] as Record<string, unknown>).rows;
  return typeof rows === "number" && Number.isSafeInteger(rows) && rows >= 0 ? rows : null;
}

export function experimentalSeriesState(
  exportManifest: Record<string, unknown>,
  analysisManifest: Record<string, unknown>,
): ExperimentalSeriesState {
  const productRelativeRows = manifestRows(exportManifest, "files", "product_relatives.csv");
  const retailerSubitemRows = manifestRows(exportManifest, "files", "retailer_subitem_daily.csv");
  const subitemRows = manifestRows(exportManifest, "files", "subitem_daily.csv");
  const aggregateDailyRows = manifestRows(exportManifest, "files", "aggregate_daily.csv");
  const analysisAggregateDailyRows = manifestRows(analysisManifest, "inputs", "aggregate_daily.csv");
  const rowMetadataValid = [
    productRelativeRows,
    retailerSubitemRows,
    subitemRows,
    aggregateDailyRows,
    analysisAggregateDailyRows,
  ].every((value) => value !== null);
  const nonempty = rowMetadataValid
    && (productRelativeRows ?? 0) > 0
    && (retailerSubitemRows ?? 0) > 0
    && (subitemRows ?? 0) > 0
    && (aggregateDailyRows ?? 0) > 0
    && analysisAggregateDailyRows === aggregateDailyRows;
  const statuses = analysisManifest.statuses as { noIndexData?: unknown } | undefined;
  const declaresNoIndexData = statuses?.noIndexData === true;
  const exportStatusAllowsSeriesState = exportManifest.status === "official_unavailable"
    || (exportManifest.status === "no_index_data") === declaresNoIndexData;
  const statusValid = exportStatusAllowsSeriesState && declaresNoIndexData === !nonempty;
  return {
    valid: rowMetadataValid && analysisAggregateDailyRows === aggregateDailyRows && statusValid,
    nonempty,
    productRelativeRows: productRelativeRows ?? 0,
    retailerSubitemRows: retailerSubitemRows ?? 0,
    subitemRows: subitemRows ?? 0,
    aggregateDailyRows: aggregateDailyRows ?? 0,
    analysisAggregateDailyRows: analysisAggregateDailyRows ?? 0,
  };
}

function m6Evaluation(
  root: string,
  database: Database.Database,
  command: CommandEvidence,
  evaluatedCommit: string,
  now: Date,
): CriterionEvaluation {
  const base = commandAcceptance("m6-index-analysis", command, "Golden index, official comparison, exports, and analysis checks pass");
  const review = reviewFindingState(root, "M6", now);
  base.evidence.push(review.evidence);
  base.criterion.evidenceIds = [...base.criterion.evidenceIds, review.evidence.id].sort();
  if (!review.valid || review.openCriticalOrImportant > 0) {
    base.criterion = criterion(
      "m6-index-analysis",
      "fail",
      "A critical/important M6 review finding is open or the review registry is invalid",
      ["REVIEW_FINDING_OPEN"],
      base.criterion.evidenceIds,
    );
    return base;
  }
  const freshPath = join(root, "data/acceptance/evidence/fresh-clone.json");
  let regenerationValid = false;
  let regenerationObservedAt = now.toISOString();
  let freshReceiptHash: string | undefined;
  try {
    const receipt = validateFreshCloneReceipt(readJson(freshPath));
    regenerationObservedAt = receipt.completedAt;
    const analysisCheck = receipt.checks.find((check) => check.id === "analysis");
    const verifierDigest = createHash("sha256")
      .update("ops/verify-fresh-clone.sh\0")
      .update(readFileSync(join(root, "ops/verify-fresh-clone.sh")))
      .update("\0scripts/create-fresh-clone-receipt.mjs\0")
      .update(readFileSync(join(root, "scripts/create-fresh-clone-receipt.mjs")))
      .digest("hex");
    regenerationValid = receipt.sourceCommit === evaluatedCommit
      && receipt.verifierSha256 === verifierDigest
      && gitSucceeds(root, ["merge-base", "--is-ancestor", receipt.sourceCommit, receipt.cloneCommit])
      && analysisCheck?.exitCode === 0
      && receipt.artifacts.length === 2;
    freshReceiptHash = hash(readFileSync(freshPath));
  } catch {
    regenerationValid = false;
  }
  const regenerationEvidence = evidence(
    "receipt-m6-analysis-regenerate",
    "receipt",
    "data/acceptance/evidence/fresh-clone.json",
    regenerationObservedAt,
    {
      freshCloneMatchesEvaluatedCommit: regenerationValid,
      analysisCommandSucceeded: regenerationValid,
    },
    freshReceiptHash,
  );
  base.evidence.push(regenerationEvidence);
  base.criterion.evidenceIds = [...base.criterion.evidenceIds, regenerationEvidence.id].sort();
  if (base.criterion.status === "fail" || !regenerationValid) {
    base.criterion = criterion("m6-index-analysis", "fail", "Index/analysis tests or clean-clone one-command regeneration evidence failed", ["OFFLINE_CHECK_FAILED"], base.criterion.evidenceIds);
    return base;
  }
  const exportLatest = join(root, "data/exports/latest.json");
  const analysisLatest = join(root, "analysis/output/latest.json");
  let pointersValid = existsSync(exportLatest) && existsSync(analysisLatest);
  for (const [latestPath, outputRoot] of [[exportLatest, join(root, "data/exports")], [analysisLatest, join(root, "analysis/output")]] as const) {
    const pointer = readJson(latestPath) as Record<string, unknown> | null;
    if (pointer === null || typeof pointer.snapshotDirectory !== "string" || typeof pointer.manifestSha256 !== "string") {
      pointersValid = false;
      continue;
    }
    const snapshot = resolve(outputRoot, pointer.snapshotDirectory);
    const manifest = join(snapshot, "manifest.json");
    if (!snapshot.startsWith(`${outputRoot}${sep}`) || !existsSync(manifest)
      || !SHA256.test(pointer.manifestSha256) || hash(readFileSync(manifest)) !== pointer.manifestSha256) {
      pointersValid = false;
    }
  }
  if (!pointersValid) {
    base.criterion = criterion("m6-index-analysis", "fail", "Required immutable export or analysis pointer/hash is missing or invalid", ["REQUIRED_ARTIFACT_MISSING"], base.criterion.evidenceIds);
    return base;
  }
  const exportPointer = readJson(exportLatest) as { snapshotDirectory: string; manifestSha256: string };
  const analysisPointer = readJson(analysisLatest) as { snapshotDirectory: string; manifestSha256: string };
  const exportManifestPath = join(root, "data/exports", exportPointer.snapshotDirectory, "manifest.json");
  const analysisManifestPath = join(root, "analysis/output", analysisPointer.snapshotDirectory, "manifest.json");
  const exportManifest = readJson(exportManifestPath) as Record<string, unknown>;
  const analysisManifest = readJson(analysisManifestPath) as Record<string, unknown>;
  const exportSources = exportManifest.sources as {
    database?: {
      counts?: Record<string, number>;
      maxima?: Record<string, string | null>;
      snapshotSha256?: string;
    };
    sidra?: { status?: string };
  } | undefined;
  const expectedCounts = exportSources?.database?.counts ?? {};
  const actualCounts: Record<string, number> = {};
  for (const table of Object.keys(expectedCounts).sort()) {
    if (!/^[a-z_]+$/u.test(table)) continue;
    actualCounts[table] = (database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count;
  }
  const maximumQueries: Record<string, string> = {
    observations: "SELECT MAX(observed_at) AS value FROM observations",
    runs: "SELECT MAX(finished_at) AS value FROM runs",
    classifications: "SELECT MAX(created_at) AS value FROM classifications",
    healing_events: "SELECT MAX(COALESCE(recovered_at, detected_at)) AS value FROM healing_events",
    retailer_state_events: "SELECT MAX(effective_at) AS value FROM retailer_state_events",
    cost_ledger: "SELECT MAX(occurred_at) AS value FROM cost_ledger",
  };
  const actualMaxima = Object.fromEntries(Object.keys(exportSources?.database?.maxima ?? {}).sort().map((name) => [
    name,
    (database.prepare(maximumQueries[name] ?? "SELECT NULL AS value").get() as { value: string | null }).value,
  ]));
  const manifestFilesValid = (manifest: Record<string, unknown>, directory: string, key: "files" | "outputs") => {
    const entries = manifest[key];
    return Array.isArray(entries) && entries.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const item = entry as Record<string, unknown>;
      if (typeof item.path !== "string" || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) return false;
      const path = resolve(directory, item.path);
      return path.startsWith(`${directory}${sep}`) && existsSync(path) && hash(readFileSync(path)) === item.sha256;
    });
  };
  const analysisInput = analysisManifest.input as { manifestSha256?: string } | undefined;
  const statuses = analysisManifest.statuses as { noIndexData?: boolean; noOfficialOverlap?: boolean } | undefined;
  const experimentalSeries = experimentalSeriesState(exportManifest, analysisManifest);
  const officialMonthlyRows = manifestRows(exportManifest, "files", "official_ipca_monthly.csv");
  const comparisonMonthlyRows = manifestRows(exportManifest, "files", "monthly_comparison.csv");
  const overlapMonthlyRows = csvOverlapRowCount(
    join(dirname(exportManifestPath), "monthly_comparison.csv"),
  );
  const experimentalCsvRows = {
    productRelativeRows: csvDataRowCount(join(dirname(exportManifestPath), "product_relatives.csv")),
    retailerSubitemRows: csvDataRowCount(join(dirname(exportManifestPath), "retailer_subitem_daily.csv")),
    subitemRows: csvDataRowCount(join(dirname(exportManifestPath), "subitem_daily.csv")),
    aggregateDailyRows: csvDataRowCount(join(dirname(exportManifestPath), "aggregate_daily.csv")),
  };
  const experimentalCsvRowsMatch = experimentalCsvRows.productRelativeRows === experimentalSeries.productRelativeRows
    && experimentalCsvRows.retailerSubitemRows === experimentalSeries.retailerSubitemRows
    && experimentalCsvRows.subitemRows === experimentalSeries.subitemRows
    && experimentalCsvRows.aggregateDailyRows === experimentalSeries.aggregateDailyRows;
  const exportStatus = String(exportManifest.status ?? "");
  const sidraStatus = exportSources?.sidra?.status;
  const officialUnavailable = exportStatus === "official_unavailable" || sidraStatus === "unavailable";
  const officialOverlapMissing = officialUnavailable
    || sidraStatus === "no_overlap"
    || officialMonthlyRows === null
    || officialMonthlyRows === 0
    || comparisonMonthlyRows === null
    || comparisonMonthlyRows === 0
    || overlapMonthlyRows === null
    || overlapMonthlyRows === 0;
  const indexStatusConsistent = exportStatus === "official_unavailable"
    || (exportStatus === "no_index_data") === (statuses?.noIndexData === true);
  const statusConsistent = indexStatusConsistent
    && (sidraStatus === "no_overlap" || officialUnavailable) === (statuses?.noOfficialOverlap === true);
  const countsMatch = Object.entries(expectedCounts).every(([key, value]) => actualCounts[key] === value)
    && Object.keys(actualCounts).length === Object.keys(expectedCounts).length;
  const expectedMaxima = exportSources?.database?.maxima ?? {};
  const maximaMatch = Object.entries(expectedMaxima).every(([key, value]) => actualMaxima[key] === value)
    && Object.keys(actualMaxima).length === Object.keys(expectedMaxima).length;
  const databaseSnapshotSha256 = database.transaction(
    () => databaseSourceSnapshotSha256(database),
  ).deferred();
  const databaseSnapshotMatches = SHA256.test(
    exportSources?.database?.snapshotSha256 ?? "",
  ) && exportSources?.database?.snapshotSha256 === databaseSnapshotSha256;
  const bindingValid = countsMatch
    && maximaMatch
    && databaseSnapshotMatches
    && analysisInput?.manifestSha256 === exportPointer.manifestSha256
    && manifestFilesValid(exportManifest, dirname(exportManifestPath), "files")
    && manifestFilesValid(analysisManifest, dirname(analysisManifestPath), "outputs")
    && statusConsistent
    && experimentalSeries.valid
    && experimentalCsvRowsMatch;
  const fileEvidence = evidence("file-m6-current-binding", "file", "data/exports/latest.json+analysis/output/latest.json", regenerationObservedAt, {
    databaseCountsMatch: countsMatch,
    databaseMaximaMatch: maximaMatch,
    databaseSnapshotMatches,
    analysisInputManifestMatches: analysisInput?.manifestSha256 === exportPointer.manifestSha256,
    artifactHashesValid: manifestFilesValid(exportManifest, dirname(exportManifestPath), "files")
      && manifestFilesValid(analysisManifest, dirname(analysisManifestPath), "outputs"),
    statusAndOverlapConsistent: statusConsistent,
    experimentalSeriesMetadataValid: experimentalSeries.valid,
    experimentalSeriesNonempty: experimentalSeries.nonempty,
    productRelativeRows: experimentalSeries.productRelativeRows,
    retailerSubitemRows: experimentalSeries.retailerSubitemRows,
    subitemRows: experimentalSeries.subitemRows,
    aggregateDailyRows: experimentalSeries.aggregateDailyRows,
    analysisAggregateDailyRows: experimentalSeries.analysisAggregateDailyRows,
    experimentalCsvRowsMatch,
    exportStatus,
    sidraStatus: sidraStatus ?? null,
    officialMonthlyRows: officialMonthlyRows ?? -1,
    comparisonMonthlyRows: comparisonMonthlyRows ?? -1,
    overlapMonthlyRows: overlapMonthlyRows ?? -1,
  }, hash(readFileSync(analysisManifestPath)));
  base.evidence.push(fileEvidence);
  base.criterion.evidenceIds = [...base.criterion.evidenceIds, fileEvidence.id].sort();
  if (!bindingValid) {
    base.criterion = criterion("m6-index-analysis", "fail", "Current database, export manifest, analysis inputs/status, or artifacts are not bound", ["EVIDENCE_CONTRADICTION"], base.criterion.evidenceIds);
  } else if (!experimentalSeries.nonempty) {
    base.criterion = criterion("m6-index-analysis", "pending", "Reproducible artifacts are valid but the experimental daily relative series has not started", ["TIME_WINDOW_NOT_ELAPSED"], base.criterion.evidenceIds);
    base.gates = [gate(
      "m6-index-analysis",
      "time",
      "TIME_WINDOW_NOT_ELAPSED",
      regenerationObservedAt,
      "Collect and classify enough consecutive observations to produce product relatives and at least one aggregate daily relative",
      "npm run research:snapshot && npm run acceptance -- --json",
      base.criterion.evidenceIds,
    )];
  } else if (officialOverlapMissing) {
    base.criterion = criterion("m6-index-analysis", "pending", "Current artifacts are valid but a nonempty official overlap comparison is not yet available", ["OFFICIAL_OVERLAP_NOT_AVAILABLE"], base.criterion.evidenceIds);
    base.gates = [gate(
      "m6-index-analysis",
      officialUnavailable ? "site" : "time",
      "OFFICIAL_OVERLAP_NOT_AVAILABLE",
      regenerationObservedAt,
      officialUnavailable
        ? "Retry the reviewed SIDRA export when the official endpoint is available"
        : "Collect through an overlapping closed official month, then regenerate the comparison",
      "npm run research:snapshot && npm run acceptance -- --json",
      base.criterion.evidenceIds,
    )];
  }
  return base;
}

export interface TimerDefinitionVerification {
  valid: boolean;
  timerCount: number;
  serviceCount: number;
  installedCount: number;
}

export function validateTimerDefinitions(
  root: string,
  installedUnitDirectory = resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user"),
): TimerDefinitionVerification {
  let timerCount = 0;
  let serviceCount = 0;
  let installedCount = 0;
  let valid = true;
  for (const timerUnit of TIMER_UNITS) {
    const name = timerUnit.slice("precos-".length, -".timer".length);
    const serviceUnit = `precos-${name}.service`;
    const timerPath = join(root, "ops", timerUnit);
    const servicePath = join(root, "ops", serviceUnit);
    if (!existsSync(timerPath) || !existsSync(servicePath)) {
      valid = false;
      continue;
    }
    timerCount += 1;
    serviceCount += 1;
    const timer = readFileSync(timerPath, "utf8");
    const service = readFileSync(servicePath, "utf8");
    valid &&= /OnCalendar=.*America\/Sao_Paulo/u.test(timer)
      && /Persistent=true/u.test(timer)
      && /RandomizedDelaySec=/u.test(timer)
      && new RegExp(`Unit=${serviceUnit.replaceAll(".", "\\.")}`, "u").test(timer)
      && /WorkingDirectory=@RELEASE_ROOT@/u.test(service)
      && /Environment=@RUNTIME_PATH@/u.test(service)
      && /Environment=@RELEASE_ID_ENV@/u.test(service)
      && /Environment=TZ=America\/Sao_Paulo/u.test(service)
      && /UMask=0077/u.test(service)
      && /ExecStartPre=@NODE_PATH@ @RELEASE_VERIFY_PATH@ verify @RELEASE_ROOT_QUOTED@ @PUBLIC_KEY_PATH@/u.test(service)
      && /ExecStart=@(?:NODE|BASH)_PATH@/u.test(service)
      && !/(?:OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_BASE_URL|NTFY_TOPIC)\s*=/u.test(`${timer}\n${service}`);
    if (name === "healing") valid &&= /After=.*precos-daily\.service/u.test(service);
    if (name === "weekly-index") valid &&= /After=.*precos-weekly-discovery\.service/u.test(service);
    if (name === "backup") valid &&= /RefuseManualStart=yes/u.test(service);

    const installedTimer = join(installedUnitDirectory, timerUnit);
    const installedService = join(installedUnitDirectory, serviceUnit);
    if (!existsSync(installedTimer) || !existsSync(installedService)) {
      valid = false;
      continue;
    }
    installedCount += 2;
    const rendered = `${readFileSync(installedTimer, "utf8")}\n${readFileSync(installedService, "utf8")}`;
    valid &&= !/@(?:RELEASE_ROOT|RELEASE_ID_ENV|RELEASE_VERIFY_PATH|RELEASE_ROOT_QUOTED|PUBLIC_KEY_PATH|NODE_PATH|NPM_PATH|BASH_PATH|CLI_PATH|RUNTIME_PATH|ENV_FILE|BACKUP_PATH|WEEKLY_INDEX_PATH)@/u.test(rendered)
      && /WorkingDirectory=\//u.test(rendered)
      && /Environment="PRECOS_RELEASE_ID=[a-f0-9]{32}"/u.test(rendered)
      && /ExecStartPre="?[^\n"]*\/v24[^/]*\/bin\/node"?[^\n]*\/dist\/ops\/release-manifest\.js"? verify/u.test(rendered)
      && /ExecStart="?\//u.test(rendered)
      && /PATH=[^\n]*\/v24[^/]*\/bin/u.test(rendered);
    if (["daily", "healing", "heartbeat", "weekly-discovery"].includes(name)) {
      valid &&= /ExecStart="?[^\n"]*\/v24[^/]*\/bin\/node"?/u.test(rendered);
    }
  }
  const dailySourcePath = join(root, "ops/precos-daily.service");
  const dailyInstalledPath = join(installedUnitDirectory, "precos-daily.service");
  const classificationSourcePath = join(root, "ops", CLASSIFICATION_SERVICE_UNIT);
  const classificationInstalledPath = join(installedUnitDirectory, CLASSIFICATION_SERVICE_UNIT);
  if (existsSync(join(root, "ops/precos-classification.timer"))
    || existsSync(join(installedUnitDirectory, "precos-classification.timer"))) valid = false;
  if (!existsSync(dailySourcePath) || !existsSync(dailyInstalledPath)
    || !existsSync(classificationSourcePath) || !existsSync(classificationInstalledPath)) {
    valid = false;
  } else {
    const daily = readFileSync(dailySourcePath, "utf8");
    const installedDaily = readFileSync(dailyInstalledPath, "utf8");
    const classification = readFileSync(classificationSourcePath, "utf8");
    const installed = readFileSync(classificationInstalledPath, "utf8");
    valid &&= /OnSuccess=precos-classification\.service/u.test(daily)
      && /OnSuccess=precos-classification\.service/u.test(installedDaily)
      && /OnFailure=precos-classification\.service/u.test(daily)
      && /OnFailure=precos-classification\.service/u.test(installedDaily)
      && /RefuseManualStart=yes/u.test(daily)
      && /RefuseManualStart=yes/u.test(installedDaily)
      && /Environment=PRECOS_SCHEDULE_SOURCE=systemd-timer/u.test(daily)
      && /Environment=PRECOS_SCHEDULE_SOURCE=systemd-timer/u.test(installedDaily)
      && /After=precos-daily\.service/u.test(classification)
      && /WorkingDirectory=@RELEASE_ROOT@/u.test(classification)
      && /Environment=@RUNTIME_PATH@/u.test(classification)
      && /Environment=@RELEASE_ID_ENV@/u.test(classification)
      && /Environment=TZ=America\/Sao_Paulo/u.test(classification)
      && /UMask=0077/u.test(classification)
      && /ExecStartPre=@NODE_PATH@ @RELEASE_VERIFY_PATH@ verify @RELEASE_ROOT_QUOTED@ @PUBLIC_KEY_PATH@/u.test(classification)
      && /ExecStart=@NODE_PATH@ @CLI_PATH@ classify --batch-size 50 --version 1 --json/u.test(classification)
      && !/@(?:RELEASE_ROOT|RELEASE_ID_ENV|RELEASE_VERIFY_PATH|RELEASE_ROOT_QUOTED|PUBLIC_KEY_PATH|NODE_PATH|CLI_PATH|RUNTIME_PATH|ENV_FILE)@/u.test(installed)
      && /After=precos-daily\.service/u.test(installed)
      && /WorkingDirectory=\//u.test(installed)
      && /PATH=[^\n]*\/v24[^/]*\/bin/u.test(installed)
      && /ExecStart="?[^\n"]*\/v24[^/]*\/bin\/node"?[^\n]* classify --batch-size 50 --version 1 --json/u.test(installed);
    installedCount += 1;
  }
  return { valid, timerCount, serviceCount, installedCount };
}

function m7Evaluation(
  root: string,
  database: Database.Database,
  sourceDatabasePath: string,
  evaluatedCommit: string,
  now: Date,
  publication: PublicationAuditReport,
  services: ServiceState[],
  userLingerEnabled: boolean,
): CriterionEvaluation {
  const id = "m7-publication-operations";
  const alertPath = join(root, "data/acceptance/evidence/alert-drill.json");
  const backupPath = join(root, "data/acceptance/evidence/backup-drill.json");
  const freshPath = join(root, "data/acceptance/evidence/fresh-clone.json");
  const alert = readDrillReceipt(alertPath, "alert");
  const backup = readDrillReceipt(backupPath, "backup");
  const alertReceiptExists = existsSync(alertPath);
  const backupReceiptExists = existsSync(backupPath);
  let freshMatches = false;
  try {
    freshMatches = validateFreshCloneReceipt(readJson(freshPath)).sourceCommit === evaluatedCommit;
  } catch {
    freshMatches = false;
  }
  const drillImplementationHash = hash(readFileSync(join(root, "src/ops/acceptance-drills.ts")));
  const alertStaticMatches = alert?.status === "pass" && alert.evaluatedCommit === evaluatedCommit
    && alert.implementationSha256 === drillImplementationHash;
  const backupMatches = backup?.status === "pass" && backup.evaluatedCommit === evaluatedCommit
    && backup.implementationSha256 === drillImplementationHash;
  const timerMap = new Map(services.map((service) => [service.unit, service]));
  const timersHealthy = TIMER_UNITS.every((unit) => {
    const state = timerMap.get(unit);
    return state?.enabled === true && state.active === true;
  });
  const timerDefinitions = validateTimerDefinitions(root);
  const timerDefinitionsValid = timerDefinitions.valid;
  const serviceFailures = SERVICE_UNITS.filter((unit) => {
    const state = timerMap.get(unit);
    if (state?.active === true) return false;
    const result = state?.result;
    return result !== null && result !== undefined && result !== "success";
  });
  const installation = readSystemdInstallationState(root, now);
  const releaseCurrent = installation.valid
    && installation.sourceCommit !== null
    && (installation.sourceCommit === evaluatedCommit
      || releaseSourceMatchesEvaluatedCommit(root, installation.sourceCommit, evaluatedCommit))
    && installation.releaseId !== null
    && installation.deployedAt !== null;
  let installedArtifactSetSha256: string | null = null;
  let installedCliSha256: string | null = null;
  if (releaseCurrent && installation.releasePath !== null) {
    try {
      const releaseManifest = readJson(join(installation.releasePath, "release-manifest.json")) as {
        artifactSetSha256?: unknown;
      };
      installedArtifactSetSha256 = typeof releaseManifest.artifactSetSha256 === "string"
        && SHA256.test(releaseManifest.artifactSetSha256)
        ? releaseManifest.artifactSetSha256 : null;
      const cliPath = join(installation.releasePath, "dist/cli.js");
      installedCliSha256 = existsSync(cliPath) ? hash(readFileSync(cliPath)) : null;
    } catch {
      installedArtifactSetSha256 = null;
      installedCliSha256 = null;
    }
  }
  const commandDigest = (command: string, args: readonly string[]): string =>
    hash([command, ...args].join("\0"));
  const alertUnit = typeof alert?.facts.transientUnit === "string"
    ? alert.facts.transientUnit : "";
  let liveAlertJournalMatches = false;
  if (alert !== null
    && typeof alert.facts.invocationId === "string"
    && /^[a-f0-9]{32}$/u.test(alert.facts.invocationId)
    && /^precos-alert-drill-[a-f0-9]{12}\.service$/u.test(alertUnit)) {
    try {
      const journal = canonicalJournalJson(execFileSync("journalctl", [
        "--user", "-u", alertUnit, "--output=json", "--no-pager", "--all",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      const invocationMatched = journal.split("\n").filter(Boolean).some((line) => {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          return entry._SYSTEMD_INVOCATION_ID === alert.facts.invocationId
            || entry.OBJECT_SYSTEMD_INVOCATION_ID === alert.facts.invocationId
            || entry.USER_INVOCATION_ID === alert.facts.invocationId;
        } catch {
          return false;
        }
      });
      liveAlertJournalMatches = invocationMatched
        && alert.facts.journalSha256 === hash(journal)
        && alert.facts.journalBytes === Buffer.byteLength(journal);
    } catch {
      liveAlertJournalMatches = false;
    }
  }
  const alertMatches = alertStaticMatches && releaseCurrent && alert !== null
    && alert.facts.protocolVersion === 2
    && alert.facts.releaseId === installation.releaseId
    && alert.facts.releaseManifestSha256 === installation.releaseManifestSha256
    && alert.facts.releaseArtifactSetSha256 === installedArtifactSetSha256
    && alert.facts.heartbeatCliArtifactSha256 === installedCliSha256
    && alert.facts.systemdRunCommandSha256 === commandDigest("systemd-run", [
      "--user",
      `--unit=${alertUnit}`,
      "--wait",
      "--expand-environment=no",
      "--property=Type=exec",
      "/bin/sh",
      "-c",
      'kill -KILL "$$"',
    ])
    && installation.releasePath !== null
    && alert.facts.dbInitCommandSha256 === commandDigest(process.execPath, [
      join(installation.releasePath, "dist/cli.js"), "db", "init",
    ])
    && alert.facts.heartbeatCommandSha256 === commandDigest(process.execPath, [
      join(installation.releasePath, "dist/cli.js"), "heartbeat", "check", "--json",
    ])
    && liveAlertJournalMatches
    && Date.parse(alert.observedAt) >= installation.deployedAt!.getTime();
  const activation = releaseCurrent ? installation.deployedAt! : now;
  const firstDailyStart = scheduledBoundaryAfter(activation, 3, 0);
  const firstDailyDeadline = deadlineForScheduledStart(firstDailyStart, 4, 0);
  const firstBackupStart = scheduledBoundaryAfter(activation, 4, 15);
  const firstBackupDeadline = deadlineForScheduledStart(firstBackupStart, 5, 15);
  const currentDailyStart = currentScheduledBoundary(firstDailyStart, now, 3, 0);
  const currentDailyDeadline = currentScheduledBoundary(firstDailyDeadline, now, 4, 0);
  const currentBackupStart = currentScheduledBoundary(firstBackupStart, now, 4, 15);
  const currentBackupDeadline = currentScheduledBoundary(firstBackupDeadline, now, 5, 15);
  const heartbeatCandidates = database.prepare(`
    SELECT scheduled_for, completed_at,
      json_extract(details_json, '$.trigger') AS heartbeat_trigger,
      json_extract(details_json, '$.timerUnit') AS timer_unit,
      json_extract(details_json, '$.serviceUnit') AS service_unit,
      json_extract(details_json, '$.provenanceVersion') AS provenance_version,
      json_extract(details_json, '$.invocationId') AS invocation_id,
      json_extract(details_json, '$.cgroupSha256') AS cgroup_sha256,
      json_extract(details_json, '$.releaseId') AS release_id,
      json_extract(details_json, '$.timerLastTriggerAt') AS timer_last_trigger_at,
      json_extract(details_json, '$.serviceStartedAt') AS service_started_at,
      json_extract(details_json, '$.timerCausalitySha256') AS timer_causality_sha256
    FROM heartbeats
    WHERE pipeline = 'collect' AND status = 'completed'
      AND COALESCE(json_array_length(details_json, '$.monitorFailedRunIds'), 0) = 0
      AND COALESCE(json_array_length(details_json, '$.retailerFailures'), 0) = 0
    ORDER BY completed_at DESC, id DESC
  `).all() as Array<{
    scheduled_for: string;
    completed_at: string;
    heartbeat_trigger: string | null;
    timer_unit: string | null;
    service_unit: string | null;
    provenance_version: number | null;
    invocation_id: string | null;
    cgroup_sha256: string | null;
    release_id: string | null;
    timer_last_trigger_at: string | null;
    service_started_at: string | null;
    timer_causality_sha256: string | null;
  }>;
  const latestHeartbeat = heartbeatCandidates.find((heartbeat) => isScheduledCollectionHeartbeat(heartbeat)
    && releaseCurrent
    && heartbeat.release_id === installation.releaseId
    && Date.parse(heartbeat.scheduled_for) >= installation.deployedAt!.getTime()
    && Date.parse(heartbeat.scheduled_for) >= currentDailyStart.getTime());
  const heartbeatAgeHours = latestHeartbeat === undefined
    ? null
    : (now.getTime() - Date.parse(latestHeartbeat.completed_at)) / 3_600_000;
  const heartbeatFresh = heartbeatAgeHours !== null && Number.isFinite(heartbeatAgeHours) && heartbeatAgeHours <= 24;
  const backupDirectory = join(root, "var/backups");
  const dailyService = timerMap.get("precos-daily.service");
  const backupService = timerMap.get("precos-backup.service");
  const dailyTimer = timerMap.get("precos-daily.timer");
  const backupTimer = timerMap.get("precos-backup.timer");
  const parseServiceTime = (value: string | null | undefined) => value === null || value === undefined ? Number.NaN : Date.parse(value);
  const dailyServiceStart = parseServiceTime(dailyService?.lastStartedAt);
  const backupServiceStart = parseServiceTime(backupService?.lastStartedAt);
  const backupServiceFinish = parseServiceTime(backupService?.lastFinishedAt);
  const timerCausallyMatchesService = (timer: ServiceState | undefined, serviceStart: number): boolean => {
    const trigger = parseServiceTime(timer?.lastTriggerAt);
    return Number.isFinite(trigger) && Number.isFinite(serviceStart)
      && Math.abs(trigger - serviceStart) <= 1_000;
  };
  const dailyScheduledServiceSucceeded = dailyService?.result === "success"
    && Number.isFinite(dailyServiceStart) && dailyServiceStart >= currentDailyStart.getTime()
    && timerCausallyMatchesService(dailyTimer, dailyServiceStart)
    && typeof dailyService.invocationId === "string"
    && dailyService.invocationId === latestHeartbeat?.invocation_id;
  const backupScheduledServiceSucceeded = backupService?.result === "success"
    && Number.isFinite(backupServiceStart) && backupServiceStart >= currentBackupStart.getTime()
    && timerCausallyMatchesService(backupTimer, backupServiceStart)
    && typeof backupService.invocationId === "string"
    && /^[a-f0-9]{32}$/u.test(backupService.invocationId);
  const receiptPaths = existsSync(backupDirectory)
    ? readdirSync(backupDirectory)
      .filter((name) => /^precos-\d{8}T\d{6}-\d+\.sqlite\.receipt\.json$/u.test(name))
      .map((name) => join(backupDirectory, name))
    : [];
  const liveSchema = database.prepare(`
    SELECT COUNT(*) AS count, MAX(version) AS version FROM schema_migrations
  `).get() as { count: number; version: number | null };
  const parsedReceipts = receiptPaths.map((receiptPath): {
    receiptPath: string;
    receipt: ScheduledBackupReceipt | null;
  } => {
    try {
      return { receiptPath, receipt: validateScheduledBackupReceipt(readJson(receiptPath)) };
    } catch {
      return { receiptPath, receipt: null };
    }
  });
  const currentReceiptPaths = parsedReceipts.filter((candidate) => candidate.receipt !== null
    && candidate.receipt.trigger === "systemd"
    && candidate.receipt.invocationId === backupService?.invocationId
    && candidate.receipt.databaseSchemaVersion === liveSchema.version
    && candidate.receipt.schemaMigrationCount === liveSchema.count
    && REQUIRED_BACKUP_TABLES.every((table) =>
      candidate.receipt?.semanticTableCounts[table] !== undefined));
  const scheduledPairs = currentReceiptPaths.map(({ receiptPath }) => validateScheduledBackupPair({
    receiptPath,
    backupDirectory,
    sourceDatabasePath,
  }));
  const eligibleScheduledPairs = scheduledPairs.filter((pair): pair is ScheduledBackupPairValidation & {
    valid: true;
    receipt: NonNullable<ScheduledBackupPairValidation["receipt"]>;
    artifactPath: string;
  } => pair.valid && pair.receipt !== null && pair.artifactPath !== null
    && pair.receipt.trigger === "systemd");
  const onlyScheduledPair = eligibleScheduledPairs.length === 1
    && currentReceiptPaths.length === 1
    ? eligibleScheduledPairs[0]
    : undefined;
  const scheduledBackup = onlyScheduledPair !== undefined
    && scheduledBackupPairMatchesService(onlyScheduledPair, {
      invocationId: backupService?.invocationId,
      startedAt: backupServiceStart,
      finishedAt: backupServiceFinish,
      currentWindowStart: currentBackupStart.getTime(),
      now: now.getTime(),
    })
    ? onlyScheduledPair
    : undefined;
  const scheduledBackupCompleted = scheduledBackup === undefined
    ? Number.NaN
    : Date.parse(scheduledBackup.receipt.completedAt);
  const newestBackupAgeHours = Number.isFinite(scheduledBackupCompleted)
    ? (now.getTime() - scheduledBackupCompleted) / 3_600_000
    : null;
  const newestBackupAfterCurrentWindow = Number.isFinite(scheduledBackupCompleted)
    && scheduledBackupCompleted >= currentBackupStart.getTime()
    && scheduledBackupCompleted <= now.getTime();
  const scheduledBackupIntegrityValid = scheduledBackup !== undefined;
  const backupBoundToService = scheduledBackup !== undefined && backupScheduledServiceSucceeded;
  const realBackupCurrent = newestBackupAgeHours !== null && newestBackupAgeHours >= 0
    && newestBackupAgeHours <= 26 && newestBackupAfterCurrentWindow
    && scheduledBackupIntegrityValid && backupBoundToService;
  const dailyWindowSatisfied = latestHeartbeat !== undefined && dailyScheduledServiceSucceeded;
  const backupWindowSatisfied = realBackupCurrent && backupScheduledServiceSucceeded;
  let backupFileHealthy = false;
  let backupAgeHours: number | null = null;
  if (typeof backup?.facts.backupArtifactIdSha256 === "string"
    && typeof backup.facts.backupSha256 === "string" && existsSync(backupDirectory)) {
    const candidateName = readdirSync(backupDirectory)
      .filter((name) => /^precos-drill-\d{14}-[a-f0-9-]+\.sqlite$/iu.test(name))
      .find((name) => hash(name) === backup.facts.backupArtifactIdSha256);
    if (candidateName !== undefined) {
      const candidate = join(backupDirectory, candidateName);
      const metadata = statSync(candidate);
      backupAgeHours = (now.getTime() - metadata.mtimeMs) / 3_600_000;
      try {
        const backupDatabase = new Database(candidate, { readonly: true, fileMustExist: true });
        const quick = backupDatabase.pragma("quick_check") as Array<Record<string, unknown>>;
        const foreignKeys = backupDatabase.pragma("foreign_key_check") as unknown[];
        backupDatabase.close();
        backupFileHealthy = (metadata.mode & 0o777) === 0o600
          && quick.length === 1 && Object.values(quick[0] ?? {})[0] === "ok"
          && foreignKeys.length === 0 && backupAgeHours <= 26
          && hash(readFileSync(candidate)) === backup.facts.backupSha256;
      } catch {
        backupFileHealthy = false;
      }
    }
  }
  const evidenceId = "service-m7-publication-operations";
  const item = evidence(evidenceId, "service", "m7-publication-and-six-timers", now.toISOString(), {
    publicationStatus: publication.status,
    publicationFindings: publication.findings.length,
    freshCloneMatches: freshMatches,
    sixTimersEnabledAndActive: timersHealthy,
    timerDefinitionsValid,
    systemdInstallReceiptValid: installation.valid,
    installedReleaseMatchesEvaluatedCommit: releaseCurrent,
    systemdInstalledAt: installation.installedAt?.toISOString() ?? null,
    systemdDeployedAt: installation.deployedAt?.toISOString() ?? null,
    systemdReleaseId: installation.releaseId,
    systemdUnitSetSha256: installation.unitSetSha256,
    userLingerEnabled,
    renderedUnitFiles: timerDefinitions.installedCount,
    failedServiceUnits: serviceFailures.length,
    alertDrillMatches: alertMatches,
    backupDrillMatches: backupMatches,
    backupIntegrityAndAgeValid: backupFileHealthy,
    backupAgeHours,
    latestCollectionHeartbeatFresh: heartbeatFresh,
    latestCollectionHeartbeatAgeHours: heartbeatAgeHours,
    firstDailyWindowElapsed: now.getTime() >= firstDailyDeadline.getTime(),
    firstBackupWindowElapsed: now.getTime() >= firstBackupDeadline.getTime(),
    currentDailyWindowElapsed: now.getTime() >= currentDailyDeadline.getTime(),
    currentBackupWindowElapsed: now.getTime() >= currentBackupDeadline.getTime(),
    newestRealBackupAgeHours: newestBackupAgeHours,
    newestScheduledBackupIntegrityValid: scheduledBackupIntegrityValid,
    scheduledBackupReceiptCount: receiptPaths.length,
    scheduledBackupCurrentReceiptCount: currentReceiptPaths.length,
    scheduledBackupInvalidReceiptCount: parsedReceipts.filter((candidate) => candidate.receipt === null).length
      + scheduledPairs.filter((pair) => !pair.valid).length,
    scheduledBackupCompletedAt: scheduledBackup?.receipt.completedAt ?? null,
    scheduledBackupArtifactSha256: scheduledBackup?.receipt.artifactSha256 ?? null,
    scheduledBackupServiceCgroupSha256: scheduledBackup?.receipt.serviceCgroupSha256 ?? null,
    scheduledBackupInvocationIdSha256: scheduledBackup?.receipt.invocationId === null
      || scheduledBackup?.receipt.invocationId === undefined
      ? null
      : hash(scheduledBackup.receipt.invocationId),
    dailyScheduledServiceSucceeded,
    backupScheduledServiceSucceeded,
    scheduledBackupBoundToService: backupBoundToService,
    dailyWindowSatisfied,
    backupWindowSatisfied,
  });
  const review = reviewFindingState(root, "M7", now);
  const criterionEvidenceIds = [evidenceId, review.evidence.id];
  const evaluationEvidence = [item, review.evidence];
  if (!review.valid || review.openCriticalOrImportant > 0) {
    return {
      criterion: criterion(id, "fail", "A critical/important M7 review finding is open or the review registry is invalid", ["REVIEW_FINDING_OPEN"], criterionEvidenceIds),
      gates: [],
      evidence: evaluationEvidence,
    };
  }
  if (publication.status === "fail") {
    return { criterion: criterion(id, "fail", "Publication audit reports a public safety defect", ["SECRET_OR_PRIVATE_ARTIFACT"], criterionEvidenceIds), gates: [], evidence: evaluationEvidence };
  }
  if (!timersHealthy || !timerDefinitionsValid || !releaseCurrent || !userLingerEnabled
    || serviceFailures.length > 0
    || (alertReceiptExists && !alertMatches)
    || (backupReceiptExists && (!backupMatches || !backupFileHealthy))
    || !freshMatches) {
    return { criterion: criterion(id, "fail", "Required static operations, receipt integrity, or timer evidence is invalid", ["EVIDENCE_CONTRADICTION"], criterionEvidenceIds), gates: [], evidence: evaluationEvidence };
  }
  if (scheduledWindowIsPending({
    now,
    deadline: currentDailyDeadline,
    evidenceSatisfied: dailyWindowSatisfied,
    serviceActive: dailyService?.active === true,
  }) || scheduledWindowIsPending({
    now,
    deadline: currentBackupDeadline,
    evidenceSatisfied: backupWindowSatisfied,
    serviceActive: backupService?.active === true,
  })) {
    return {
      criterion: criterion(id, "pending", "The first applicable scheduled daily/backup windows have not both elapsed", ["SCHEDULED_RUN_NOT_YET_DUE"], criterionEvidenceIds),
      gates: [gate(id, "time", "SCHEDULED_RUN_NOT_YET_DUE", activation.toISOString(), "Let both installed São Paulo schedules reach their first real windows", "npm run acceptance -- --json", criterionEvidenceIds)],
      evidence: evaluationEvidence,
    };
  }
  if ((latestHeartbeat === undefined || !dailyScheduledServiceSucceeded) && now.getTime() >= currentDailyDeadline.getTime()) {
    return { criterion: criterion(id, "fail", "The first daily window elapsed without a collection heartbeat", ["MISSED_SCHEDULED_RUN"], criterionEvidenceIds), gates: [], evidence: evaluationEvidence };
  }
  if (!realBackupCurrent && now.getTime() >= currentBackupDeadline.getTime()) {
    return { criterion: criterion(id, "fail", "The first backup window elapsed without a current integrity-valid backup", ["MISSED_SCHEDULED_RUN"], criterionEvidenceIds), gates: [], evidence: evaluationEvidence };
  }
  if (latestHeartbeat === undefined || !realBackupCurrent) {
    const reason = "SCHEDULED_RUN_NOT_YET_DUE";
    return {
      criterion: criterion(id, "pending", "The first applicable production heartbeat/backup window has not elapsed", [reason], criterionEvidenceIds),
      gates: [gate(id, "time", reason, activation.toISOString(), "Let the installed timers reach their first real São Paulo windows", "npm run acceptance -- --json", criterionEvidenceIds)],
      evidence: evaluationEvidence,
    };
  }
  if (alert === null || backup === null) {
    return {
      criterion: criterion(id, "pending", "Explicit safe production drills await author execution", ["AUTHORITY_APPROVAL_REQUIRED"], criterionEvidenceIds),
      gates: [gate(id, "authority", "AUTHORITY_APPROVAL_REQUIRED", null, "Run both explicit safe drills after reviewing their production target", "npm run acceptance:drill -- alert --confirm-safe-drill --json && npm run acceptance:drill -- backup --confirm-safe-drill --json", criterionEvidenceIds)],
      evidence: evaluationEvidence,
    };
  }
  if (!heartbeatFresh) {
    return { criterion: criterion(id, "fail", "The latest real collection heartbeat is older than 24 hours", ["MISSED_SCHEDULED_RUN"], criterionEvidenceIds), gates: [], evidence: evaluationEvidence };
  }
  return { criterion: criterion(id, "pass", "Publication, six timers, safe drills, backup, and heartbeat evidence are current", [], criterionEvidenceIds), gates: [], evidence: evaluationEvidence };
}

export async function buildAcceptanceReport(options: AcceptanceOptions): Promise<AcceptanceReport> {
  const root = realpathSync(options.projectRoot);
  const databasePath = realpathSync(options.databasePath);
  const evaluatedCommit = resolveAcceptanceEvaluatedCommit(root);
  const now = options.now();
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const m1Command = await options.runCommand("m1-offline", "npm", ["test", "--", "tests/normalize", "tests/strategies", "tests/collection", "tests/discovery", "tests/retailers", "tests/pipeline/collect.test.ts", "tests/pipeline/discover.test.ts"]);
    const m5Command = await options.runCommand("m5-healing", "npm", ["test", "--", "tests/healing", "tests/ops/systemd.test.ts"]);
    const m6Command = await options.runCommand("m6-index-analysis", "npm", ["test", "--", "tests/index", "tests/analysis"]);
    const [services, publication, userLingerEnabled] = await Promise.all([
      options.serviceReader.read([...TIMER_UNITS, ...SERVICE_UNITS, CLASSIFICATION_SERVICE_UNIT]),
      auditPublication({
        projectRoot: root,
        databasePath,
        now: options.now,
        requireClean: false,
        requireAcceptanceEvidence: false,
        evaluatedCommit,
      }),
      options.serviceReader.readUserLingerEnabled?.() ?? Promise.resolve(false),
    ]);
    const cleanSource = sourceWorktreeClean(root);
    const m0 = m0Evaluation(root, database, evaluatedCommit, now, cleanSource);
    const m1 = commandAcceptance("m1-offline-determinism", m1Command, "Offline normalization, extraction, discovery, and retailer safety suites pass");
    const inventory = m1Inventory(root, now);
    m1.evidence.push(inventory);
    m1.criterion.evidenceIds = [...m1.criterion.evidenceIds, inventory.id].sort();
    if (inventory.facts.inventoryComplete !== true) {
      m1.criterion = criterion("m1-offline-determinism", "fail", "Offline suite or required tier/mutation fixture inventory is incomplete", ["REQUIRED_ARTIFACT_MISSING"], m1.criterion.evidenceIds);
    }
    const systemdInstallation = readSystemdInstallationState(root, now);
    const m2 = evaluateM2(
      database,
      now,
      systemdInstallation.valid ? systemdInstallation.deployedAt : null,
      systemdInstallation.valid ? systemdInstallation.releaseId : null,
    );
    const m3 = evaluateM3(database, {
      credentialConfigured: options.credentialConfigured ?? false,
      siteValidated: options.siteValidated ?? false,
      decisionsDocumented: /three-retailer[\s\S]{0,160}swap[\s\S]{0,160}(?:sonda|mambo|shibata)|(?:sonda|mambo|shibata)[\s\S]{0,160}three-retailer[\s\S]{0,160}swap/iu
        .test(readFileSync(join(root, "ops/decisions.md"), "utf8")),
      namedBackupDocumented: database.prepare(`
        SELECT 1 FROM retailers
        WHERE active = 1 AND (lower(name) LIKE '%sonda%'
          OR lower(name) LIKE '%mambo%' OR lower(name) LIKE '%shibata%')
        LIMIT 1
      `).get() !== undefined,
      blockedDayTriggerProven: hasThreeConsecutiveDays(database.prepare(`
        SELECT run.retailer_id, run.collection_day FROM runs AS run
        JOIN retailers AS retailer ON retailer.id = run.retailer_id
        WHERE retailer.active = 0 AND run.status = 'failed'
          AND error_category IN ('http-403', 'http-429', 'captcha', 'domain-denied', 'timeout', 'network')
        ORDER BY run.retailer_id, run.collection_day
      `).all() as Array<{ retailer_id: string; collection_day: string }>),
      ...(systemdInstallation.valid
        && systemdInstallation.deployedAt !== null
        && systemdInstallation.releaseId !== null
        ? {
            deployedAt: systemdInstallation.deployedAt,
            releaseId: systemdInstallation.releaseId,
          }
        : {}),
    }, now);
    const humanReview = evaluateClassificationHumanReview(root, database, now);
    m3.criteria.push(humanReview.criterion);
    m3.gates.push(...humanReview.gates);
    m3.evidence.push(...humanReview.evidence);
    const strategyValidationReceipts = evaluateActiveStrategyValidationReceipts(root, database, now);
    m3.criteria.push(strategyValidationReceipts.criterion);
    m3.gates.push(...strategyValidationReceipts.gates);
    m3.evidence.push(...strategyValidationReceipts.evidence);
    const operationsActivation = systemdInstallation.valid
      && systemdInstallation.deployedAt !== null
      ? systemdInstallation.deployedAt
      : now;
    const currentDailyStart = currentScheduledBoundary(scheduledBoundaryAfter(operationsActivation, 3, 0), now, 3, 0);
    const dailyState = services.find((service) => service.unit === "precos-daily.service");
    const classificationState = services.find((service) => service.unit === CLASSIFICATION_SERVICE_UNIT);
    const classificationAutomation = classificationAutomationIsCurrent({
      dailyActive: dailyState?.active ?? false,
      dailyResult: dailyState?.result ?? null,
      dailyStartedAt: dailyState?.lastStartedAt ?? null,
      classificationActive: classificationState?.active ?? false,
      classificationResult: classificationState?.result ?? null,
      classificationStartedAt: classificationState?.lastStartedAt ?? null,
      currentDailyStart,
    });
    const { dailyRunObserved } = classificationAutomation;
    const classificationAutomationCurrent = classificationAutomation.current;
    const classificationUnitsValid = validateTimerDefinitions(root).valid;
    const classificationEvidence = evidence("service-m3-classification-automation", "service", CLASSIFICATION_SERVICE_UNIT, now.toISOString(), {
      dailyRunObserved,
      classificationUnitInstalled: classificationUnitsValid,
      classificationActive: classificationState?.active ?? false,
      classificationResult: classificationState?.result ?? null,
      classificationAutomationCurrent,
    });
    m3.evidence.push(classificationEvidence);
    if (!classificationUnitsValid || !classificationAutomationCurrent) {
      m3.criteria.push(criterion(
        "m3-post-daily-automation",
        "fail",
        "Post-collection classification automation is missing, failed, or stale",
        ["UNSAFE_CONFIGURATION"],
        [classificationEvidence.id],
      ));
    } else {
      m3.criteria.push(criterion(
        "m3-post-daily-automation",
        "pass",
        "Post-collection classification automation is installed and current",
        [],
        [classificationEvidence.id],
      ));
    }
    const m4 = evaluateM4(database, {
      credentialConfigured: options.explorerCredentialConfigured
        ?? options.credentialConfigured
        ?? false,
      spendAuthorized: options.spendAuthorized ?? false,
      siteValidated: options.siteValidated ?? false,
    }, now);
    const m5 = commandAcceptance("m5-automatic-healing", m5Command, "Isolated sabotage, drift/blocking, recovery, and timer suites pass");
    const m5Review = reviewFindingState(root, "M5", now);
    const m5Live = evaluateM5HealingDrill({
      root,
      evaluatedCommit,
      now,
      credentialConfigured: options.explorerCredentialConfigured
        ?? options.credentialConfigured
        ?? false,
      spendAuthorized: options.spendAuthorized ?? false,
      installation: systemdInstallation,
    });
    m5.evidence.push(m5Review.evidence, ...m5Live.evidence);
    m5.gates = [...m5Live.gates];
    const m5EvidenceIds = [
      ...m5.criterion.evidenceIds,
      m5Review.evidence.id,
      ...m5Live.criterion.evidenceIds,
    ].sort();
    const healingTimer = services.find((service) => service.unit === "precos-healing.timer");
    if (!m5Review.valid || m5Review.openCriticalOrImportant > 0) {
      m5.criterion = criterion("m5-automatic-healing", "fail", "A critical/important M5 review finding is open or the review registry is invalid", ["REVIEW_FINDING_OPEN"], m5EvidenceIds);
      m5.gates = [];
    } else if (m5.criterion.status !== "pass") {
      m5.criterion = { ...m5.criterion, evidenceIds: m5EvidenceIds };
      m5.gates = [];
    } else if (healingTimer?.enabled !== true || healingTimer.active !== true) {
      m5.criterion = criterion("m5-automatic-healing", "fail", "Healing tests pass but the independent worker timer is not enabled and active", ["UNSAFE_CONFIGURATION"], m5EvidenceIds);
      m5.gates = [];
    } else {
      m5.criterion = { ...m5Live.criterion, evidenceIds: m5EvidenceIds };
    }
    const m6 = m6Evaluation(root, database, m6Command, evaluatedCommit, now);
    const m7 = m7Evaluation(
      root,
      database,
      databasePath,
      evaluatedCommit,
      now,
      publication,
      services,
      userLingerEnabled,
    );
    const evaluations: Record<MilestoneId, M3Evaluation> = {
      M0: { criteria: [m0.criterion], gates: m0.gates, evidence: m0.evidence },
      M1: { criteria: [m1.criterion], gates: m1.gates, evidence: m1.evidence },
      M2: { criteria: [m2.criterion], gates: m2.gates, evidence: m2.evidence },
      M3: m3,
      M4: { criteria: [m4.criterion], gates: m4.gates, evidence: m4.evidence },
      M5: { criteria: [m5.criterion], gates: m5.gates, evidence: m5.evidence },
      M6: { criteria: [m6.criterion], gates: m6.gates, evidence: m6.evidence },
      M7: { criteria: [m7.criterion], gates: m7.gates, evidence: m7.evidence },
    };
    const milestones = Object.fromEntries(MILESTONES.map((milestone) => {
      const evaluation = evaluations[milestone];
      return [milestone, {
        status: aggregateAcceptanceStatus(evaluation.criteria.map((item) => item.status)),
        criteria: evaluation.criteria,
      }];
    })) as Record<MilestoneId, MilestoneAcceptance>;
    const allEvidence = MILESTONES.flatMap((milestone) => evaluations[milestone].evidence);
    for (const command of [m1Command, m5Command, m6Command]) {
      const item = commandEvidenceToAcceptance(command);
      if (!allEvidence.some((candidate) => candidate.id === item.id)) allEvidence.push(item);
    }
    const databaseSha256 = await coherentDatabaseHash(database);
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      timezone: "America/Sao_Paulo",
      evaluatedCommit,
      databaseSha256,
      overallStatus: aggregateAcceptanceStatus(MILESTONES.map((milestone) => milestones[milestone].status)),
      milestones,
      publication,
      pendingGates: MILESTONES.flatMap((milestone) => evaluations[milestone].gates)
        .sort((left, right) => left.criterionId.localeCompare(right.criterionId)),
      evidence: allEvidence.sort((left, right) => left.id.localeCompare(right.id)),
    };
  } finally {
    database.close();
  }
}

export function renderAcceptanceMarkdown(report: AcceptanceReport): string {
  const lines = [
    "# Full Charter Acceptance Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Evaluated implementation commit: \`${report.evaluatedCommit}\``,
    `Overall status: **${report.overallStatus.toUpperCase()}**`,
    "",
    "This report records evidence without converting external time, credential, site, or author gates into success.",
    "",
    "## Milestones",
    "",
    "| Milestone | Status | Criterion | Reason codes |",
    "| --- | --- | --- | --- |",
  ];
  for (const milestone of MILESTONES) {
    for (const item of report.milestones[milestone].criteria) {
      lines.push(`| ${milestone} | ${item.status.toUpperCase()} | ${item.summary.replaceAll("|", "\\|")} | ${item.reasonCodes.join(", ") || "—"} |`);
    }
  }
  lines.push("", "## Pending gates", "");
  if (report.pendingGates.length === 0) lines.push("No pending gates.");
  else {
    for (const pending of report.pendingGates) {
      lines.push(`- **${pending.criterionId} — ${pending.reasonCode} (${pending.kind})**: ${pending.nextAction} Recheck with \`${pending.recheckCommand}\`.`);
    }
  }
  lines.push("", "## Evidence index", "");
  for (const item of report.evidence) {
    lines.push(`- \`${item.id}\` — ${item.kind}, source \`${item.source}\`${item.sha256 === undefined ? "" : `, SHA-256 \`${item.sha256}\``}.`);
  }
  lines.push("", "## Publication boundary", "", `Publication audit: **${report.publication.status.toUpperCase()}**; findings: ${report.publication.findings.length}.`, "");
  return `${lines.join("\n")}\n`;
}

function allowedEvidencePath(path: string): boolean {
  return isAcceptanceEvidencePath(path);
}

function exactObjectKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

export function validateAcceptanceReportShape(input: unknown): AcceptanceReport {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("Acceptance snapshot must be an object");
  const report = input as Record<string, unknown>;
  if (!exactObjectKeys(report, [
    "schemaVersion", "generatedAt", "timezone", "evaluatedCommit", "databaseSha256",
    "overallStatus", "milestones", "publication", "pendingGates", "evidence",
  ]) || report.schemaVersion !== 1 || report.timezone !== "America/Sao_Paulo"
    || typeof report.generatedAt !== "string" || !Number.isFinite(Date.parse(report.generatedAt))
    || typeof report.evaluatedCommit !== "string" || !COMMIT.test(report.evaluatedCommit)
    || typeof report.databaseSha256 !== "string" || !SHA256.test(report.databaseSha256)
    || !["pass", "pending", "fail"].includes(String(report.overallStatus))
    || typeof report.milestones !== "object" || report.milestones === null
    || !Array.isArray(report.pendingGates) || !Array.isArray(report.evidence)
    || typeof report.publication !== "object" || report.publication === null) {
    throw new TypeError("Acceptance snapshot top-level schema is invalid");
  }
  const milestones = report.milestones as Record<string, unknown>;
  if (!exactObjectKeys(milestones, MILESTONES)) throw new TypeError("Acceptance milestone keys are invalid");
  const evidenceIds = new Set<string>();
  for (const item of report.evidence as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError("Acceptance evidence entry is invalid");
    const row = item as Record<string, unknown>;
    const keys = row.sha256 === undefined
      ? ["id", "kind", "source", "observedAt", "facts"]
      : ["id", "kind", "source", "observedAt", "sha256", "facts"];
    if (!exactObjectKeys(row, keys) || typeof row.id !== "string" || row.id === "" || evidenceIds.has(row.id)
      || !["command", "database-query", "file", "service", "receipt"].includes(String(row.kind))
      || typeof row.source !== "string" || isAbsolute(row.source) || row.source.split("/").includes("..")
      || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))
      || (row.sha256 !== undefined && (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)))
      || typeof row.facts !== "object" || row.facts === null || Array.isArray(row.facts)
      || Object.values(row.facts as Record<string, unknown>).some((fact) => fact !== null && !["string", "number", "boolean"].includes(typeof fact))) {
      throw new TypeError("Acceptance evidence entry is not strictly sanitized");
    }
    evidenceIds.add(row.id);
  }
  const pendingByCriterion = new Map<string, number>();
  for (const pending of report.pendingGates as unknown[]) {
    if (typeof pending !== "object" || pending === null || Array.isArray(pending)) throw new TypeError("Pending gate is invalid");
    const row = pending as Record<string, unknown>;
    if (!exactObjectKeys(row, ["criterionId", "kind", "reasonCode", "since", "nextAction", "recheckCommand", "evidenceIds"])
      || typeof row.criterionId !== "string" || !["time", "credential", "site", "authority"].includes(String(row.kind))
      || typeof row.reasonCode !== "string" || !REASON_CODES.has(row.reasonCode)
      || (row.since !== null && (typeof row.since !== "string" || !Number.isFinite(Date.parse(row.since))))
      || typeof row.nextAction !== "string" || typeof row.recheckCommand !== "string"
      || !Array.isArray(row.evidenceIds) || row.evidenceIds.some((id) => typeof id !== "string" || !evidenceIds.has(id))) {
      throw new TypeError("Pending gate schema/evidence is invalid");
    }
    pendingByCriterion.set(row.criterionId, (pendingByCriterion.get(row.criterionId) ?? 0) + 1);
  }
  const statuses: AcceptanceStatus[] = [];
  const criterionReasons = new Map<string, Set<string>>();
  for (const milestone of MILESTONES) {
    const value = milestones[milestone];
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Milestone is invalid");
    const row = value as Record<string, unknown>;
    if (!exactObjectKeys(row, ["status", "criteria"]) || !["pass", "pending", "fail"].includes(String(row.status)) || !Array.isArray(row.criteria) || row.criteria.length === 0) {
      throw new TypeError("Milestone schema is invalid");
    }
    const criterionStatuses: AcceptanceStatus[] = [];
    for (const item of row.criteria) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError("Criterion is invalid");
      const current = item as Record<string, unknown>;
      if (!exactObjectKeys(current, ["id", "status", "summary", "reasonCodes", "evidenceIds"])
        || typeof current.id !== "string" || !["pass", "pending", "fail"].includes(String(current.status))
        || typeof current.summary !== "string" || current.summary === "" || !Array.isArray(current.reasonCodes)
        || current.reasonCodes.some((code) => typeof code !== "string" || !REASON_CODES.has(code))
        || new Set(current.reasonCodes).size !== current.reasonCodes.length
        || !Array.isArray(current.evidenceIds) || current.evidenceIds.some((id) => typeof id !== "string" || !evidenceIds.has(id))
        || new Set(current.evidenceIds).size !== current.evidenceIds.length
        || (current.status === "pass" && current.evidenceIds.length === 0)
        || current.status === "fail"
        || (current.status === "pending" && pendingByCriterion.get(current.id) !== 1)
        || (current.status !== "pending" && pendingByCriterion.has(current.id))) {
        throw new TypeError("Criterion status/evidence/gate binding is invalid");
      }
      criterionReasons.set(current.id, new Set(current.reasonCodes as string[]));
      criterionStatuses.push(current.status as AcceptanceStatus);
    }
    if (aggregateAcceptanceStatus(criterionStatuses) !== row.status) throw new TypeError("Milestone aggregation is invalid");
    statuses.push(row.status as AcceptanceStatus);
  }
  if (aggregateAcceptanceStatus(statuses) !== report.overallStatus || report.overallStatus === "fail") throw new TypeError("Overall aggregation is invalid or failed");
  for (const pending of report.pendingGates as PendingGate[]) {
    if (!criterionReasons.get(pending.criterionId)?.has(pending.reasonCode)) throw new TypeError("Pending gate reason does not match its criterion");
  }
  const publication = report.publication as unknown as Record<string, unknown>;
  const publicationFindingArrays = [
    "trackedSecrets", "historicalSecrets", "trackedPrivateArtifacts", "trackedRawHtml",
    "unsafeLinksOrSubmodules", "publicDataFindings", "findings",
  ];
  const expectedReadmeClaims = [
    "acceptanceCommandDocumented", "acceptanceReportLinked", "activeDevelopment",
    "defendedMethodClaim", "noStatisticalValidationClaim", "outOfScopeExplicit",
    "rawHtmlExcluded", "researchPilot",
  ];
  if (!exactObjectKeys(publication, [
    "schemaVersion", "generatedAt", "commit", "status", "trackedSecrets",
    "historicalSecrets", "trackedPrivateArtifacts", "trackedRawHtml",
    "unsafeLinksOrSubmodules", "publicDataFindings", "requiredDocsMissing",
    "readmeClaims", "workingTreeClean", "findings",
  ]) || publication.schemaVersion !== 1 || publication.status !== "pass"
    || publication.commit !== report.evaluatedCommit
    || publicationFindingArrays.some((key) => !Array.isArray(publication[key]) || (publication[key] as unknown[]).length !== 0)
    || !Array.isArray(publication.requiredDocsMissing) || publication.requiredDocsMissing.length !== 0
    || typeof publication.readmeClaims !== "object" || publication.readmeClaims === null
    || !exactObjectKeys(publication.readmeClaims as Record<string, unknown>, expectedReadmeClaims)
    || Object.values(publication.readmeClaims as Record<string, unknown>).some((claim) => claim !== true)) {
    throw new TypeError("Snapshot publication audit schema/commit did not pass");
  }
  const serialized = JSON.stringify(report);
  if (/"[^"]*Passed"\s*:\s*true/iu.test(serialized) || PRIVATE_ABSOLUTE_PATH_FOR_ACCEPTANCE.test(serialized)) {
    throw new TypeError("Snapshot contains an unsupported boolean claim or private path");
  }
  return input as AcceptanceReport;
}

const PRIVATE_ABSOLUTE_PATH_FOR_ACCEPTANCE = /(?:^|[\s"'])\/(?:home|root|Users|private|tmp)\//u;

export async function verifyAcceptanceSnapshot(
  projectRoot: string,
  snapshotPath: string,
): Promise<SnapshotVerification> {
  const root = realpathSync(projectRoot);
  let report: AcceptanceReport | null = null;
  const reasonCodes: string[] = [];
  try {
    report = validateAcceptanceReportShape(readJson(snapshotPath));
  } catch {
    reasonCodes.push("EVIDENCE_CONTRADICTION");
  }
  const headCommit = git(root, ["rev-parse", "HEAD"]);
  const evaluatedCommit = report?.evaluatedCommit ?? "";
  if (!COMMIT.test(evaluatedCommit) || !gitSucceeds(root, ["merge-base", "--is-ancestor", evaluatedCommit, headCommit])) {
    reasonCodes.push("EVIDENCE_CONTRADICTION");
  }
  const changedPaths = COMMIT.test(evaluatedCommit)
    ? git(root, ["diff", "--name-only", `${evaluatedCommit}..${headCommit}`]).split("\n").filter(Boolean).sort()
    : [];
  if (changedPaths.some((path) => !allowedEvidencePath(path))) reasonCodes.push("REQUIRED_ARTIFACT_MISSING");
  if (COMMIT.test(evaluatedCommit)) {
    try {
      if (resolveAcceptanceEvaluatedCommit(root) !== evaluatedCommit) {
        reasonCodes.push("EVIDENCE_CONTRADICTION");
      }
    } catch {
      reasonCodes.push("EVIDENCE_CONTRADICTION");
    }
  }
  if (git(root, ["status", "--porcelain=v1"]) !== "") reasonCodes.push("EVIDENCE_CONTRADICTION");
  if (report !== null) {
    const databasePath = join(root, "data/precos.sqlite");
    try {
      const database = new Database(databasePath, { readonly: true, fileMustExist: true });
      let currentDatabaseHash: string;
      try {
        currentDatabaseHash = await coherentDatabaseHash(database);
        const currentCriteria = [
          evaluateClassificationHumanReview(root, database, new Date(report.generatedAt)).criterion,
          evaluateActiveStrategyValidationReceipts(root, database, new Date(report.generatedAt)).criterion,
        ];
        for (const current of currentCriteria) {
          const recorded = report.milestones.M3.criteria.find((item) => item.id === current.id);
          if (recorded?.status !== current.status || recorded.summary !== current.summary
            || recorded.reasonCodes.join("\0") !== current.reasonCodes.join("\0")) {
            reasonCodes.push("EVIDENCE_CONTRADICTION");
          }
        }
      } finally {
        database.close();
      }
      if (currentDatabaseHash !== report.databaseSha256) reasonCodes.push("EVIDENCE_CONTRADICTION");
    } catch {
      reasonCodes.push("DATABASE_INTEGRITY_FAILED");
    }
    const recordedM5 = report.milestones.M5.criteria.find(
      ({ id }) => id === "m5-automatic-healing",
    );
    if (recordedM5?.status === "pass") {
      try {
        const generatedAt = new Date(report.generatedAt);
        const currentM5 = evaluateM5HealingDrill({
          root,
          evaluatedCommit,
          now: generatedAt,
          credentialConfigured: false,
          spendAuthorized: false,
          installation: readSystemdInstallationState(root, generatedAt),
        });
        const currentEvidence = currentM5.evidence.find(
          ({ id }) => id === "receipt-m5-installed-release-healing-sabotage",
        );
        const recordedEvidence = report.evidence.find(
          ({ id }) => id === "receipt-m5-installed-release-healing-sabotage",
        );
        if (currentM5.criterion.status !== "pass"
          || currentM5.criterion.summary !== recordedM5.summary
          || currentM5.criterion.reasonCodes.join("\0") !== recordedM5.reasonCodes.join("\0")
          || currentEvidence?.source !== recordedEvidence?.source
          || currentEvidence?.observedAt !== recordedEvidence?.observedAt
          || currentEvidence?.sha256 !== recordedEvidence?.sha256) {
          reasonCodes.push("EVIDENCE_CONTRADICTION");
        }
      } catch {
        reasonCodes.push("EVIDENCE_CONTRADICTION");
      }
    }
    const markdownPath = join(root, "docs/acceptance-report.md");
    if (!existsSync(markdownPath) || readFileSync(markdownPath, "utf8") !== renderAcceptanceMarkdown(report)) {
      reasonCodes.push("REQUIRED_ARTIFACT_MISSING");
    }
    try {
      const fresh = validateFreshCloneReceipt(readJson(join(root, "data/acceptance/evidence/fresh-clone.json")));
      const expectedArtifacts = [
        ["analysis/output/latest.json", "analysis/output"],
        ["data/exports/latest.json", "data/exports"],
      ].map(([latest, base]) => {
        const pointer = readJson(join(root, latest ?? "")) as { snapshotDirectory?: string } | null;
        return pointer?.snapshotDirectory === undefined ? "" : `${base}/${pointer.snapshotDirectory}/manifest.json`;
      }).sort();
      if (fresh.sourceCommit !== evaluatedCommit
        || fresh.artifacts.map((item) => item.path).sort().join("\0") !== expectedArtifacts.join("\0")
        || fresh.artifacts.some((item) => !existsSync(join(root, item.path)) || hash(readFileSync(join(root, item.path))) !== item.sha256)) {
        reasonCodes.push("EVIDENCE_CONTRADICTION");
      }
      const implementationHash = hash(readFileSync(join(root, "src/ops/acceptance-drills.ts")));
      for (const drill of ["alert", "backup"] as const) {
        const receipt = validatePublicDrillReceipt(readJson(join(root, `data/acceptance/evidence/${drill}-drill.json`)), drill);
        if (receipt.status !== "pass" || receipt.evaluatedCommit !== evaluatedCommit || receipt.implementationSha256 !== implementationHash) {
          reasonCodes.push("EVIDENCE_CONTRADICTION");
        }
      }
    } catch {
      reasonCodes.push("REQUIRED_ARTIFACT_MISSING");
    }
    try {
      const publication = await auditPublication({
        projectRoot: root,
        databasePath,
        now: () => new Date(report.generatedAt),
        requireClean: true,
        requireAcceptanceEvidence: true,
        evaluatedCommit,
      });
      if (publication.status !== "pass") reasonCodes.push("REQUIRED_ARTIFACT_MISSING");
    } catch {
      reasonCodes.push("EVIDENCE_CONTRADICTION");
    }
  }
  return {
    status: reasonCodes.length === 0 ? "pass" : "fail",
    evaluatedCommit,
    headCommit,
    changedPaths,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}
