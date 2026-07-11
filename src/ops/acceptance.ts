import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import {
  auditPublication,
  validateFreshCloneReceipt,
  type PublicationAuditReport,
} from "../publication/audit.js";
import { validatePublicDrillReceipt, type PublicDrillReceipt } from "./acceptance-drills.js";

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
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
}

export interface ServiceStateReader {
  read(units: string[]): Promise<ServiceState[]>;
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
  const dailyRunObserved = input.dailyResult === "success" && Number.isFinite(dailyStartedAt)
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
  installedAt: Date | null;
  unitSetSha256: string | null;
}

export function readSystemdInstallationState(
  root: string,
  now: Date,
  installedUnitDirectory = resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user"),
): SystemdInstallationState {
  const path = join(root, "var/operations/systemd-install.json");
  const parsed = readJson(path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || !exactObjectKeys(parsed as Record<string, unknown>, ["installedAt", "schemaVersion", "unitSetSha256", "units"])) {
    return { valid: false, installedAt: null, unitSetSha256: null };
  }
  const receipt = parsed as Record<string, unknown>;
  const installedAtMs = typeof receipt.installedAt === "string" ? Date.parse(receipt.installedAt) : Number.NaN;
  if (receipt.schemaVersion !== 1 || !Number.isFinite(installedAtMs) || installedAtMs > now.getTime()
    || new Date(installedAtMs).toISOString() !== receipt.installedAt
    || typeof receipt.unitSetSha256 !== "string" || !SHA256.test(receipt.unitSetSha256)
    || !Array.isArray(receipt.units) || receipt.units.length !== ALL_SYSTEMD_UNITS.length
    || !existsSync(path) || (statSync(path).mode & 0o777) !== 0o600) {
    return { valid: false, installedAt: null, unitSetSha256: null };
  }
  const names = new Set<string>();
  const units: Array<{ name: string; sha256: string }> = [];
  for (const value of receipt.units) {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !exactObjectKeys(value as Record<string, unknown>, ["name", "sha256"])) {
      return { valid: false, installedAt: null, unitSetSha256: null };
    }
    const unit = value as Record<string, unknown>;
    if (typeof unit.name !== "string" || !ALL_SYSTEMD_UNITS.includes(unit.name)
      || names.has(unit.name) || typeof unit.sha256 !== "string" || !SHA256.test(unit.sha256)) {
      return { valid: false, installedAt: null, unitSetSha256: null };
    }
    const installedPath = join(installedUnitDirectory, unit.name);
    if (!existsSync(installedPath) || hash(readFileSync(installedPath)) !== unit.sha256) {
      return { valid: false, installedAt: null, unitSetSha256: null };
    }
    names.add(unit.name);
    units.push({ name: unit.name, sha256: unit.sha256 });
  }
  units.sort((left, right) => left.name.localeCompare(right.name));
  const computedSetHash = hash(units.map((unit) => `${unit.name}\0${unit.sha256}\n`).join(""));
  if (computedSetHash !== receipt.unitSetSha256) {
    return { valid: false, installedAt: null, unitSetSha256: null };
  }
  return {
    valid: true,
    installedAt: new Date(installedAtMs),
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
  run_id: string;
  retailer_id: string;
  collection_day: string;
  status: string;
  run_started_at: string;
  run_finished_at: string | null;
  latest_observation_at: string | null;
  attempted: number;
  ok: number;
  failed: number;
  validation_sample_size: number;
  validation_rate: number | null;
  active_products: number;
  observation_rows: number;
}

const M2_QUERY = `
WITH active_product_counts AS (
  SELECT retailer_id, COUNT(*) AS active_products
  FROM products
  WHERE active = 1 AND in_scope = 1
  GROUP BY retailer_id
), heartbeat_run_ids AS (
  SELECT
    heartbeat.id AS heartbeat_id,
    heartbeat.scheduled_for,
    heartbeat.completed_at,
    json_extract(heartbeat.details_json, '$.trigger') AS heartbeat_trigger,
    json_extract(heartbeat.details_json, '$.timerUnit') AS timer_unit,
    run_id.value AS run_id
  FROM heartbeats AS heartbeat,
       json_each(heartbeat.details_json, '$.runIds') AS run_id
  WHERE heartbeat.pipeline = 'collect'
    AND heartbeat.status = 'completed'
    AND json_valid(heartbeat.details_json)
    AND json_type(heartbeat.details_json, '$.runIds') = 'array'
)
SELECT
  linked.heartbeat_id,
  linked.scheduled_for,
  linked.completed_at,
  linked.heartbeat_trigger,
  linked.timer_unit,
  run.id AS run_id,
  run.retailer_id,
  run.collection_day,
  run.status,
  run.started_at AS run_started_at,
  run.finished_at AS run_finished_at,
  run.attempted,
  run.ok,
  run.failed,
  strategy.validation_sample_size,
  strategy.validation_rate,
  products.active_products,
  COUNT(observation.id) AS observation_rows,
  MAX(observation.observed_at) AS latest_observation_at
FROM heartbeat_run_ids AS linked
JOIN runs AS run ON run.id = linked.run_id
JOIN strategies AS strategy ON strategy.id = run.strategy_id
JOIN active_product_counts AS products ON products.retailer_id = run.retailer_id
LEFT JOIN observations AS observation ON observation.run_id = run.id
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
  trigger: "systemd-timer";
  timerUnit: "precos-daily.timer";
} {
  return typeof value === "object" && value !== null
    && (value as Record<string, unknown>).trigger === "systemd-timer"
    && (value as Record<string, unknown>).timerUnit === "precos-daily.timer";
}

function validateHeartbeatLinks(database: Database.Database, now: Date): string[] {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.details_json);
    } catch {
      contradictions.push(row.id);
      continue;
    }
    const runIds = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).runIds
      : undefined;
    if (!Array.isArray(runIds) || runIds.length === 0
      || runIds.some((id) => typeof id !== "string" || id === "")
      || new Set(runIds).size !== runIds.length
      || !validTimestampAtOrBefore(row.scheduled_for, now)
      || !validTimestampAtOrBefore(row.completed_at, now)
      || Date.parse(row.completed_at) < Date.parse(row.scheduled_for)
      || ((parsed as Record<string, unknown>).trigger === "systemd-timer"
        && !scheduledHeartbeatDetails(parsed))) {
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
}): boolean {
  return input.heartbeat_trigger === "systemd-timer"
    && input.timer_unit === "precos-daily.timer";
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

function currentScheduledBoundary(first: Date, now: Date, hour: number, minute: number): Date {
  const today = scheduledBoundaryForDay(saoPauloDay(now), hour, minute);
  return today.getTime() < first.getTime() ? first : today;
}

export function evaluateM2(
  database: Database.Database,
  now: Date,
  scheduleActivatedAt: Date | null = null,
): CriterionEvaluation {
  const id = "m2-two-consecutive-days";
  const contradictions = validateHeartbeatLinks(database, now);
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
    && row.collection_day === saoPauloDay(row.scheduled_for));
  const selectedHeartbeatByDay = new Map<string, string>();
  const heartbeatRows = database.prepare(`
    SELECT id, scheduled_for, completed_at,
      json_extract(details_json, '$.trigger') AS heartbeat_trigger,
      json_extract(details_json, '$.timerUnit') AS timer_unit
    FROM heartbeats
    WHERE pipeline = 'collect' AND status = 'completed'
    ORDER BY scheduled_for, id
  `).all() as Array<{
    id: string;
    scheduled_for: string;
    completed_at: string;
    heartbeat_trigger: string | null;
    timer_unit: string | null;
  }>;
  const scheduledHeartbeats = heartbeatRows.filter(isScheduledCollectionHeartbeat);
  for (const heartbeat of heartbeatRows) {
    if (!isScheduledCollectionHeartbeat(heartbeat)) continue;
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
    && row.attempted === row.ok + row.failed
    && row.ok * 10 >= row.attempted * 9
    && row.attempted >= Math.min(30, row.active_products)
    && row.validation_sample_size === 30
    && row.validation_rate !== null
    && row.validation_rate >= 0.9
    && row.observation_rows === row.ok);
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
    : scheduledBoundaryAfter(scheduleActivatedAt, 4, 0);
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
}

export function evaluateM3(
  database: Database.Database,
  options: M3GateOptions,
  now = new Date(),
): CriterionEvaluation {
  const id = "m3-panel-classification";
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
  const retailersWithCollectionEvidence = (database.prepare(`
    SELECT COUNT(*) AS count FROM retailers AS retailer
    WHERE retailer.active = 1 AND EXISTS (
      SELECT 1 FROM runs AS run
      WHERE run.retailer_id = retailer.id AND run.stage = 'collect'
        AND run.status IN ('completed', 'partial') AND run.attempted > 0
        AND (SELECT COUNT(*) FROM observations AS observation WHERE observation.run_id = run.id) = run.ok
        AND run.ok > 0
    )
  `).get() as { count: number }).count;
  const activeProducts = rows.reduce((sum, row) => sum + row.active_in_scope_products, 0);
  const highConfidence = rows.reduce((sum, row) => sum + row.high_confidence_products, 0);
  const ratioPass = activeProducts > 0 && highConfidence * 5 >= activeProducts * 4;
  const panelExceptionPass = retailerFacts.activeRetailers === 3
    && options.decisionsDocumented === true
    && options.namedBackupDocumented === true
    && options.blockedDayTriggerProven === true;
  const panelPass = retailerFacts.activeRetailers >= 4 || panelExceptionPass;
  const evidenceId = "db-m3-latest-classification-coverage";
  const resultEvidence = evidence(evidenceId, "database-query", "m3-latest-classification-coverage", now.toISOString(), {
    activeRetailers: retailerFacts.activeRetailers,
    degradedRetailers: retailerFacts.degradedRetailers,
    activeProducts,
    highConfidenceProducts: highConfidence,
    classificationCoverage: activeProducts === 0 ? 0 : highConfidence / activeProducts,
    panelExceptionApproved: panelExceptionPass,
    retailersWithTerminalObservedCollection: retailersWithCollectionEvidence,
  });
  if (panelPass && retailerFacts.degradedRetailers === 0 && ratioPass
    && retailersWithCollectionEvidence === retailerFacts.activeRetailers) {
    return { criterion: criterion(id, "pass", "Panel size and latest-version high-confidence classification meet the charter", [], [evidenceId]), gates: [], evidence: [resultEvidence] };
  }
  if (retailerFacts.degradedRetailers > 0) {
    return {
      criterion: criterion(id, "fail", "An active retailer is degraded", ["UNSAFE_CONFIGURATION"], [evidenceId]),
      gates: [],
      evidence: [resultEvidence],
    };
  }
  let kind: PendingGateKind = "site";
  let reason = "SITE_VALIDATION_PENDING";
  let action = "Complete documented regional retailer/site validation without degrading the live panel";
  if (!options.credentialConfigured && !ratioPass) {
    kind = "credential";
    reason = "CREDENTIAL_NOT_CONFIGURED";
    action = "Configure the classification credential privately, then run the normal reviewed classification workflow";
  } else if (retailerFacts.activeRetailers === 3 && !panelExceptionPass) {
    kind = "site";
    reason = "SITE_VALIDATION_PENDING";
    action = "Activate a validated fourth retailer or record the exact named-backup swap after three blocked days";
  } else if (options.siteValidated && options.credentialConfigured) {
    return { criterion: criterion(id, "fail", "Available panel/classification evidence does not meet the declared threshold", ["EVIDENCE_CONTRADICTION"], [evidenceId]), gates: [], evidence: [resultEvidence] };
  }
  return {
    criterion: criterion(id, "pending", "Panel or high-confidence classification remains externally gated", [reason], [evidenceId]),
    gates: [gate(id, kind, reason, null, action, "npm run acceptance -- --json", [evidenceId])],
    evidence: [resultEvidence],
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

function sourceWorktreeClean(root: string): boolean {
  const porcelain = git(root, ["status", "--porcelain=v1"]);
  if (porcelain === "") return true;
  return porcelain.split("\n").every((line) => {
    const raw = line.slice(3);
    const path = raw.includes(" -> ") ? raw.split(" -> ").at(-1) ?? raw : raw;
    return allowedEvidencePath(path);
  });
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
  const fixtureRoot = join(root, "tests/fixtures");
  const mutatedFixtures = existsSync(fixtureRoot)
    ? readdirSync(fixtureRoot, { recursive: true }).filter((path) => String(path).includes("mutated-product")).length
    : 0;
  return evidence("file-m1-fixture-inventory", "file", "tests/fixtures", now.toISOString(), {
    requiredOfflineTestFiles: requiredFiles.length,
    requiredOfflineTestFilesPresent: requiredFiles.filter((path) => existsSync(join(root, path))).length,
    mutatedRetailerFixtures: mutatedFixtures,
    inventoryComplete: requiredFiles.every((path) => existsSync(join(root, path))) && mutatedFixtures >= 5,
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
      || !["M5", "M6", "M7"].includes(String(finding.milestone))
      || !["critical", "important", "minor"].includes(String(finding.severity))
      || !["open", "resolved"].includes(String(finding.status))
      || (resolved && (typeof finding.fixCommit !== "string" || !COMMIT.test(finding.fixCommit)
        || !gitSucceeds(root, ["merge-base", "--is-ancestor", finding.fixCommit, "HEAD"])))
      || (!resolved && finding.fixCommit !== null)) {
      valid = false;
    }
    if (typeof finding.id === "string") ids.add(finding.id);
  }
  const scoped = findings.filter((finding) => finding.milestone === milestone);
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
  const migrations = (database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count;
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
    sourceWorktreeClean: sourceClean,
  }, receiptHash);
  const passed = receiptValid && receiptRuntimeValid && receiptArtifactsValid
    && runtimeOk && quickOk && foreignKeys === 0 && migrations >= 10 && sourceClean;
  return {
    criterion: criterion(id, passed ? "pass" : "fail", passed
      ? "Clean-clone receipt, declared runtime, migrations, and read-only database checks pass"
      : "Foundation or clean-clone reproducibility evidence is missing or invalid",
    passed ? [] : [receiptValid ? "DATABASE_INTEGRITY_FAILED" : "REQUIRED_ARTIFACT_MISSING"], [evidenceId]),
    gates: [],
    evidence: [item],
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
    regenerationValid = receipt.sourceCommit === evaluatedCommit
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
    database?: { counts?: Record<string, number>; maxima?: Record<string, string | null> };
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
  const exportStatus = String(exportManifest.status ?? "");
  const sidraStatus = exportSources?.sidra?.status;
  const officialUnavailable = exportStatus === "official_unavailable" || sidraStatus === "unavailable";
  const statusConsistent = (exportStatus === "no_index_data") === (statuses?.noIndexData === true)
    && (sidraStatus === "no_overlap" || officialUnavailable) === (statuses?.noOfficialOverlap === true);
  const countsMatch = Object.entries(expectedCounts).every(([key, value]) => actualCounts[key] === value)
    && Object.keys(actualCounts).length === Object.keys(expectedCounts).length;
  const expectedMaxima = exportSources?.database?.maxima ?? {};
  const maximaMatch = Object.entries(expectedMaxima).every(([key, value]) => actualMaxima[key] === value)
    && Object.keys(actualMaxima).length === Object.keys(expectedMaxima).length;
  const bindingValid = countsMatch
    && maximaMatch
    && analysisInput?.manifestSha256 === exportPointer.manifestSha256
    && manifestFilesValid(exportManifest, dirname(exportManifestPath), "files")
    && manifestFilesValid(analysisManifest, dirname(analysisManifestPath), "outputs")
    && statusConsistent;
  const fileEvidence = evidence("file-m6-current-binding", "file", "data/exports/latest.json+analysis/output/latest.json", regenerationObservedAt, {
    databaseCountsMatch: countsMatch,
    databaseMaximaMatch: maximaMatch,
    analysisInputManifestMatches: analysisInput?.manifestSha256 === exportPointer.manifestSha256,
    artifactHashesValid: manifestFilesValid(exportManifest, dirname(exportManifestPath), "files")
      && manifestFilesValid(analysisManifest, dirname(analysisManifestPath), "outputs"),
    statusAndOverlapConsistent: statusConsistent,
    exportStatus,
    sidraStatus: sidraStatus ?? null,
  }, hash(readFileSync(analysisManifestPath)));
  base.evidence.push(fileEvidence);
  base.criterion.evidenceIds = [...base.criterion.evidenceIds, fileEvidence.id].sort();
  if (!bindingValid) {
    base.criterion = criterion("m6-index-analysis", "fail", "Current database, export manifest, analysis inputs/status, or artifacts are not bound", ["EVIDENCE_CONTRADICTION"], base.criterion.evidenceIds);
  } else if (officialUnavailable) {
    base.criterion = criterion("m6-index-analysis", "pending", "Current artifacts are valid but the official overlap source is unavailable", ["OFFICIAL_OVERLAP_NOT_AVAILABLE"], base.criterion.evidenceIds);
    base.gates = [gate(
      "m6-index-analysis",
      "site",
      "OFFICIAL_OVERLAP_NOT_AVAILABLE",
      regenerationObservedAt,
      "Retry the reviewed SIDRA export when the official endpoint is available",
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
      && /WorkingDirectory=@PROJECT_ROOT@/u.test(service)
      && /Environment=@RUNTIME_PATH@/u.test(service)
      && /Environment=TZ=America\/Sao_Paulo/u.test(service)
      && /UMask=0077/u.test(service)
      && /ExecStart=@(?:NODE|BASH)_PATH@/u.test(service)
      && !/(?:OPENAI_API_KEY|CODEX_API_KEY|NTFY_TOPIC)\s*=/u.test(`${timer}\n${service}`);
    if (name === "healing") valid &&= /After=.*precos-daily\.service/u.test(service);
    if (name === "weekly-index") valid &&= /After=.*precos-weekly-discovery\.service/u.test(service);

    const installedTimer = join(installedUnitDirectory, timerUnit);
    const installedService = join(installedUnitDirectory, serviceUnit);
    if (!existsSync(installedTimer) || !existsSync(installedService)) {
      valid = false;
      continue;
    }
    installedCount += 2;
    const rendered = `${readFileSync(installedTimer, "utf8")}\n${readFileSync(installedService, "utf8")}`;
    valid &&= !/@(?:PROJECT_ROOT|NODE_PATH|NPM_PATH|BASH_PATH|CLI_PATH|RUNTIME_PATH|ENV_FILE|BACKUP_PATH|WEEKLY_INDEX_PATH)@/u.test(rendered)
      && /WorkingDirectory=\//u.test(rendered)
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
      && /RefuseManualStart=yes/u.test(daily)
      && /RefuseManualStart=yes/u.test(installedDaily)
      && /Environment=PRECOS_SCHEDULE_SOURCE=systemd-timer/u.test(daily)
      && /Environment=PRECOS_SCHEDULE_SOURCE=systemd-timer/u.test(installedDaily)
      && /After=precos-daily\.service/u.test(classification)
      && /WorkingDirectory=@PROJECT_ROOT@/u.test(classification)
      && /Environment=@RUNTIME_PATH@/u.test(classification)
      && /Environment=TZ=America\/Sao_Paulo/u.test(classification)
      && /UMask=0077/u.test(classification)
      && /ExecStart=@NODE_PATH@ @CLI_PATH@ classify --batch-size 50 --version 1 --json/u.test(classification)
      && !/@(?:PROJECT_ROOT|NODE_PATH|CLI_PATH|RUNTIME_PATH|ENV_FILE)@/u.test(installed)
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
  evaluatedCommit: string,
  now: Date,
  publication: PublicationAuditReport,
  services: ServiceState[],
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
  const alertMatches = alert?.status === "pass" && alert.evaluatedCommit === evaluatedCommit
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
  const activation = installation.installedAt ?? now;
  const firstDailyStart = scheduledBoundaryAfter(activation, 3, 0);
  const firstDailyDeadline = scheduledBoundaryAfter(activation, 4, 0);
  const firstBackupStart = scheduledBoundaryAfter(activation, 4, 15);
  const firstBackupDeadline = scheduledBoundaryAfter(activation, 5, 15);
  const currentDailyStart = currentScheduledBoundary(firstDailyStart, now, 3, 0);
  const currentDailyDeadline = currentScheduledBoundary(firstDailyDeadline, now, 4, 0);
  const currentBackupStart = currentScheduledBoundary(firstBackupStart, now, 4, 15);
  const currentBackupDeadline = currentScheduledBoundary(firstBackupDeadline, now, 5, 15);
  const heartbeatCandidates = database.prepare(`
    SELECT scheduled_for, completed_at,
      json_extract(details_json, '$.trigger') AS heartbeat_trigger,
      json_extract(details_json, '$.timerUnit') AS timer_unit
    FROM heartbeats
    WHERE pipeline = 'collect' AND status = 'completed'
    ORDER BY completed_at DESC, id DESC
  `).all() as Array<{
    scheduled_for: string;
    completed_at: string;
    heartbeat_trigger: string | null;
    timer_unit: string | null;
  }>;
  const latestHeartbeat = heartbeatCandidates.find((heartbeat) => isScheduledCollectionHeartbeat(heartbeat)
    && Date.parse(heartbeat.scheduled_for) >= currentDailyStart.getTime());
  const heartbeatAgeHours = latestHeartbeat === undefined
    ? null
    : (now.getTime() - Date.parse(latestHeartbeat.completed_at)) / 3_600_000;
  const heartbeatFresh = heartbeatAgeHours !== null && Number.isFinite(heartbeatAgeHours) && heartbeatAgeHours <= 24;
  const backupDirectory = join(root, "var/backups");
  const backupFiles = existsSync(backupDirectory)
    ? readdirSync(backupDirectory).filter((name) => /^precos-\d{8}T\d{6}-\d+\.sqlite$/u.test(name))
      .map((name) => join(backupDirectory, name)).sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    : [];
  const newestBackupAgeHours = backupFiles[0] === undefined ? null : (now.getTime() - statSync(backupFiles[0]).mtimeMs) / 3_600_000;
  const newestBackupAfterCurrentWindow = backupFiles[0] !== undefined && statSync(backupFiles[0]).mtimeMs >= currentBackupStart.getTime();
  let scheduledBackupIntegrityValid = false;
  if (backupFiles[0] !== undefined && (statSync(backupFiles[0]).mode & 0o777) === 0o600) {
    try {
      const scheduledBackup = new Database(backupFiles[0], { readonly: true, fileMustExist: true });
      const quick = scheduledBackup.pragma("quick_check") as Array<Record<string, unknown>>;
      const foreignKeys = scheduledBackup.pragma("foreign_key_check") as unknown[];
      scheduledBackup.close();
      scheduledBackupIntegrityValid = quick.length === 1 && Object.values(quick[0] ?? {})[0] === "ok" && foreignKeys.length === 0;
    } catch {
      scheduledBackupIntegrityValid = false;
    }
  }
  const dailyService = timerMap.get("precos-daily.service");
  const backupService = timerMap.get("precos-backup.service");
  const parseServiceTime = (value: string | null | undefined) => value === null || value === undefined ? Number.NaN : Date.parse(value);
  const dailyServiceStart = parseServiceTime(dailyService?.lastStartedAt);
  const backupServiceStart = parseServiceTime(backupService?.lastStartedAt);
  const dailyScheduledServiceSucceeded = dailyService?.result === "success"
    && Number.isFinite(dailyServiceStart) && dailyServiceStart >= currentDailyStart.getTime();
  const backupScheduledServiceSucceeded = backupService?.result === "success"
    && Number.isFinite(backupServiceStart) && backupServiceStart >= currentBackupStart.getTime();
  const backupBoundToService = backupFiles[0] !== undefined && backupScheduledServiceSucceeded
    && Math.abs(statSync(backupFiles[0]).mtimeMs - backupServiceStart) <= 60 * 60 * 1_000;
  const realBackupCurrent = newestBackupAgeHours !== null && newestBackupAgeHours <= 26
    && newestBackupAfterCurrentWindow && scheduledBackupIntegrityValid && backupBoundToService;
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
    systemdInstalledAt: installation.installedAt?.toISOString() ?? null,
    systemdUnitSetSha256: installation.unitSetSha256,
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
    dailyScheduledServiceSucceeded,
    backupScheduledServiceSucceeded,
    scheduledBackupBoundToService: backupBoundToService,
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
  if (!timersHealthy || !timerDefinitionsValid || !installation.valid || serviceFailures.length > 0
    || (alertReceiptExists && !alertMatches)
    || (backupReceiptExists && (!backupMatches || !backupFileHealthy))
    || !freshMatches) {
    return { criterion: criterion(id, "fail", "Required static operations, receipt integrity, or timer evidence is invalid", ["EVIDENCE_CONTRADICTION"], criterionEvidenceIds), gates: [], evidence: evaluationEvidence };
  }
  if (now.getTime() < currentDailyDeadline.getTime() || now.getTime() < currentBackupDeadline.getTime()
    || dailyService?.active === true || backupService?.active === true) {
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
  const evaluatedCommit = git(root, ["rev-parse", "HEAD"]);
  if (!COMMIT.test(evaluatedCommit)) throw new Error("Acceptance requires a Git implementation commit");
  const now = options.now();
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const m1Command = await options.runCommand("m1-offline", "npm", ["test", "--", "tests/normalize", "tests/strategies", "tests/collection", "tests/discovery", "tests/retailers", "tests/pipeline/collect.test.ts", "tests/pipeline/discover.test.ts"]);
    const m5Command = await options.runCommand("m5-healing", "npm", ["test", "--", "tests/healing", "tests/ops/systemd.test.ts"]);
    const m6Command = await options.runCommand("m6-index-analysis", "npm", ["test", "--", "tests/index", "tests/analysis"]);
    const [services, publication] = await Promise.all([
      options.serviceReader.read([...TIMER_UNITS, ...SERVICE_UNITS, CLASSIFICATION_SERVICE_UNIT]),
      auditPublication({ projectRoot: root, databasePath, now: options.now, requireClean: false }),
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
      systemdInstallation.valid ? systemdInstallation.installedAt : null,
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
    }, now);
    const operationsActivation = systemdInstallation.valid
      && systemdInstallation.installedAt !== null
      ? systemdInstallation.installedAt
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
    m3.criterion.evidenceIds = [...m3.criterion.evidenceIds, classificationEvidence.id].sort();
    if (!classificationUnitsValid || !classificationAutomationCurrent) {
      m3.criterion = criterion("m3-panel-classification", "fail", "Post-collection classification automation is missing, failed, or stale", ["UNSAFE_CONFIGURATION"], m3.criterion.evidenceIds);
      m3.gates = [];
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
    m5.evidence.push(m5Review.evidence);
    m5.criterion.evidenceIds = [...m5.criterion.evidenceIds, m5Review.evidence.id].sort();
    const healingTimer = services.find((service) => service.unit === "precos-healing.timer");
    if (!m5Review.valid || m5Review.openCriticalOrImportant > 0) {
      m5.criterion = criterion("m5-automatic-healing", "fail", "A critical/important M5 review finding is open or the review registry is invalid", ["REVIEW_FINDING_OPEN"], m5.criterion.evidenceIds);
    } else if (m5.criterion.status === "pass" && (healingTimer?.enabled !== true || healingTimer.active !== true)) {
      m5.criterion = criterion("m5-automatic-healing", "fail", "Healing tests pass but the independent worker timer is not enabled and active", ["UNSAFE_CONFIGURATION"], m5.criterion.evidenceIds);
    }
    const m6 = m6Evaluation(root, database, m6Command, evaluatedCommit, now);
    const m7 = m7Evaluation(root, database, evaluatedCommit, now, publication, services);
    const evaluations = [m0, m1, m2, m3, m4, m5, m6, m7];
    const milestones = Object.fromEntries(MILESTONES.map((milestone, index) => {
      const evaluation = evaluations[index];
      if (evaluation === undefined) throw new Error("Acceptance milestone evaluation missing");
      return [milestone, { status: evaluation.criterion.status, criteria: [evaluation.criterion] }];
    })) as Record<MilestoneId, MilestoneAcceptance>;
    const allEvidence = evaluations.flatMap((evaluation) => evaluation.evidence);
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
      pendingGates: evaluations.flatMap((evaluation) => evaluation.gates)
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
  return path.startsWith("data/acceptance/")
    || path === "docs/acceptance-report.md"
    || path === "data/precos.sqlite"
    || path.startsWith("data/exports/")
    || path.startsWith("analysis/output/");
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
  if (git(root, ["status", "--porcelain=v1"]) !== "") reasonCodes.push("EVIDENCE_CONTRADICTION");
  if (report !== null) {
    const databasePath = join(root, "data/precos.sqlite");
    try {
      const database = new Database(databasePath, { readonly: true, fileMustExist: true });
      const currentDatabaseHash = await coherentDatabaseHash(database);
      database.close();
      if (currentDatabaseHash !== report.databaseSha256) reasonCodes.push("EVIDENCE_CONTRADICTION");
    } catch {
      reasonCodes.push("DATABASE_INTEGRITY_FAILED");
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
  }
  return {
    status: reasonCodes.length === 0 ? "pass" : "fail",
    evaluatedCommit,
    headCommit,
    changedPaths,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}
