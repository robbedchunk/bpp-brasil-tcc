import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import {
  auditPublication,
  validateFreshCloneReceipt,
  type PublicationAuditReport,
} from "../publication/audit.js";
import type { PublicDrillReceipt } from "./acceptance-drills.js";

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

export interface AcceptanceOptions {
  projectRoot: string;
  databasePath: string;
  now: () => Date;
  runCommand: (id: string, command: string, args: string[]) => Promise<CommandEvidence>;
  serviceReader: ServiceStateReader;
  credentialConfigured?: boolean;
  spendAuthorized?: boolean;
  siteValidated?: boolean;
  authorityApproved?: boolean;
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
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
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
  run_id: string;
  retailer_id: string;
  collection_day: string;
  status: string;
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
  run.id AS run_id,
  run.retailer_id,
  run.collection_day,
  run.status,
  run.attempted,
  run.ok,
  run.failed,
  strategy.validation_sample_size,
  strategy.validation_rate,
  products.active_products,
  COUNT(observation.id) AS observation_rows
FROM heartbeat_run_ids AS linked
JOIN runs AS run ON run.id = linked.run_id
JOIN strategies AS strategy ON strategy.id = run.strategy_id
JOIN active_product_counts AS products ON products.retailer_id = run.retailer_id
LEFT JOIN observations AS observation ON observation.run_id = run.id
WHERE run.stage = 'collect'
  AND run.status IN ('completed', 'partial')
GROUP BY linked.heartbeat_id, run.id, strategy.id, products.active_products
ORDER BY run.collection_day, run.retailer_id, run.started_at, run.id`;

function validateHeartbeatLinks(database: Database.Database): string[] {
  const rows = database.prepare(`
    SELECT id, details_json
    FROM heartbeats
    WHERE pipeline = 'collect' AND status = 'completed'
    ORDER BY completed_at, id
  `).all() as Array<{ id: string; details_json: string }>;
  const contradictions: string[] = [];
  const runExists = database.prepare("SELECT 1 FROM runs WHERE id = ?");
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
      || runIds.some((id) => runExists.get(id) === undefined)) {
      contradictions.push(row.id);
    }
  }
  return contradictions;
}

function nextDay(day: string): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function evaluateM2(database: Database.Database, now: Date): CriterionEvaluation {
  const id = "m2-two-consecutive-days";
  const contradictions = validateHeartbeatLinks(database);
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
  const rows = database.prepare(M2_QUERY).all() as M2Row[];
  const qualifying = rows.filter((row) =>
    row.attempted > 0
    && row.attempted === row.ok + row.failed
    && row.ok * 10 >= row.attempted * 9
    && row.attempted >= Math.min(30, row.active_products)
    && row.validation_sample_size === 30
    && row.validation_rate !== null
    && row.validation_rate >= 0.9
    && row.observation_rows > 0);
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
  const latestHeartbeat = database.prepare(`
    SELECT MAX(completed_at) AS completedAt
    FROM heartbeats WHERE pipeline = 'collect' AND status = 'completed'
  `).get() as { completedAt: string | null };
  const resultEvidence = evidence(
    evidenceId,
    "database-query",
    "m2-heartbeat-linked-collection-runs",
    now.toISOString(),
    {
      linkedRuns: rows.length,
      qualifyingRuns: qualifying.length,
      qualifyingRetailers: daysByRetailer.size,
      qualifyingConsecutiveRetailers: passingPair?.[1].size ?? 0,
      qualifyingDayPair: passingPair?.[0] ?? null,
      contradictoryHeartbeats: contradictions.length,
    },
  );
  if (passingPair !== undefined) {
    return {
      criterion: criterion(id, "pass", "Two retailers have two consecutive qualifying scheduled collection days", [], [evidenceId]),
      gates: [],
      evidence: [resultEvidence],
    };
  }
  const latestTime = latestHeartbeat.completedAt === null ? null : Date.parse(latestHeartbeat.completedAt);
  const stale = latestTime !== null && Number.isFinite(latestTime)
    && now.getTime() - latestTime > 48 * 60 * 60 * 1_000;
  if (stale) {
    return {
      criterion: criterion(id, "fail", "A scheduled collection boundary elapsed without current qualifying evidence", ["MISSED_SCHEDULED_RUN"], [evidenceId]),
      gates: [],
      evidence: [resultEvidence],
    };
  }
  return {
    criterion: criterion(id, "pending", "Two consecutive qualifying collection days have not yet matured", ["TIME_WINDOW_NOT_ELAPSED"], [evidenceId]),
    gates: [gate(id, "time", "TIME_WINDOW_NOT_ELAPSED", latestHeartbeat.completedAt, "Let the installed daily schedule collect the next real São Paulo calendar day", "npm run acceptance -- --json", [evidenceId])],
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
  authorityApproved: boolean;
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
  const activeProducts = rows.reduce((sum, row) => sum + row.active_in_scope_products, 0);
  const highConfidence = rows.reduce((sum, row) => sum + row.high_confidence_products, 0);
  const ratioPass = activeProducts > 0 && highConfidence * 5 >= activeProducts * 4;
  const panelPass = retailerFacts.activeRetailers >= 4
    || (retailerFacts.activeRetailers === 3 && options.authorityApproved);
  const evidenceId = "db-m3-latest-classification-coverage";
  const resultEvidence = evidence(evidenceId, "database-query", "m3-latest-classification-coverage", now.toISOString(), {
    activeRetailers: retailerFacts.activeRetailers,
    degradedRetailers: retailerFacts.degradedRetailers,
    activeProducts,
    highConfidenceProducts: highConfidence,
    classificationCoverage: activeProducts === 0 ? 0 : highConfidence / activeProducts,
    panelExceptionApproved: retailerFacts.activeRetailers === 3 && options.authorityApproved,
  });
  if (panelPass && retailerFacts.degradedRetailers === 0 && ratioPass) {
    return { criterion: criterion(id, "pass", "Panel size and latest-version high-confidence classification meet the charter", [], [evidenceId]), gates: [], evidence: [resultEvidence] };
  }
  let kind: PendingGateKind = "site";
  let reason = "SITE_VALIDATION_PENDING";
  let action = "Complete documented regional retailer/site validation without degrading the live panel";
  if (!options.credentialConfigured && !ratioPass) {
    kind = "credential";
    reason = "CREDENTIAL_NOT_CONFIGURED";
    action = "Configure the classification credential privately, then run the normal reviewed classification workflow";
  } else if (retailerFacts.activeRetailers === 3 && !options.authorityApproved) {
    kind = "authority";
    reason = "AUTHORITY_APPROVAL_REQUIRED";
    action = "Record author approval and the documented three-retailer swap evidence";
  } else if (options.siteValidated && options.credentialConfigured) {
    return { criterion: criterion(id, "fail", "Available panel/classification evidence does not meet the declared threshold", ["EVIDENCE_CONTRADICTION"], [evidenceId]), gates: [], evidence: [resultEvidence] };
  }
  return {
    criterion: criterion(id, "pending", "Panel or high-confidence classification remains externally gated", [reason], [evidenceId]),
    gates: [gate(id, kind, reason, null, action, "npm run acceptance -- --json", [evidenceId])],
    evidence: [resultEvidence],
  };
}

function evaluateM4(
  database: Database.Database,
  options: { credentialConfigured: boolean; spendAuthorized: boolean; siteValidated: boolean },
  now: Date,
): CriterionEvaluation {
  const id = "m4-live-agent-strategies";
  const activeRetailers = (database.prepare("SELECT COUNT(*) AS count FROM retailers WHERE active = 1").get() as { count: number }).count;
  const rows = database.prepare(`
    WITH purposes(purpose) AS (VALUES ('discovery'), ('extraction'))
    SELECT retailer.id AS retailer_id, purpose.purpose,
      strategy.id AS strategy_id, strategy.model, strategy.prompt_version,
      strategy.validation_sample_size, strategy.validation_rate,
      exploration.id AS exploration_run_id, exploration.outcome AS exploration_outcome,
      attempt.attempt_number, attempt.prompt_hash, attempt.external_sample_size,
      attempt.external_successes, attempt.external_score, attempt.input_tokens,
      attempt.output_tokens, attempt.cost_usd, attempt.cost_estimated,
      attempt.outcome AS attempt_outcome,
      reservation.id AS reservation_id, ledger.id AS ledger_id
    FROM retailers AS retailer
    CROSS JOIN purposes AS purpose
    LEFT JOIN strategies AS strategy ON strategy.retailer_id = retailer.id
      AND strategy.purpose = purpose.purpose AND strategy.active = 1
    LEFT JOIN exploration_runs AS exploration ON exploration.candidate_strategy_id = strategy.id
      AND exploration.outcome = 'activated'
    LEFT JOIN exploration_attempts AS attempt ON attempt.exploration_run_id = exploration.id
      AND attempt.outcome = 'activated'
    LEFT JOIN model_budget_reservations AS reservation ON reservation.exploration_run_id = exploration.id
      AND reservation.status IN ('settled', 'released')
    LEFT JOIN cost_ledger AS ledger ON ledger.exploration_run_id = exploration.id
    WHERE retailer.active = 1
    ORDER BY retailer.id, purpose.purpose, attempt.attempt_number
  `).all() as Array<Record<string, unknown>>;
  const validPairs = new Set(rows.filter((row) =>
    typeof row.strategy_id === "string"
    && typeof row.model === "string"
    && typeof row.prompt_version === "string"
    && row.exploration_outcome === "activated"
    && typeof row.prompt_hash === "string"
    && Number(row.external_sample_size) === 30
    && Number(row.external_successes) >= 27
    && Number(row.external_score) >= 0.9
    && row.attempt_outcome === "activated"
    && typeof row.reservation_id === "string"
    && typeof row.ledger_id === "string"
  ).map((row) => `${String(row.retailer_id)}/${String(row.purpose)}`));
  const requiredPairs = activeRetailers * 2;
  const evidenceId = "db-m4-agent-activated-strategies";
  const resultEvidence = evidence(evidenceId, "database-query", "m4-agent-activated-strategies", now.toISOString(), {
    activeRetailers,
    requiredPurposePairs: requiredPairs,
    qualifyingPurposePairs: validPairs.size,
    credentialGateConfigured: options.credentialConfigured,
    liveSpendAuthorized: options.spendAuthorized,
  });
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

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readDrillReceipt(path: string): PublicDrillReceipt | null {
  const value = readJson(path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || (row.drill !== "alert" && row.drill !== "backup")
    || !["pass", "pending", "fail"].includes(String(row.status))
    || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))
    || typeof row.evaluatedCommit !== "string" || !COMMIT.test(row.evaluatedCommit)
    || typeof row.implementationSha256 !== "string" || !SHA256.test(row.implementationSha256)
    || !Array.isArray(row.reasonCodes) || typeof row.facts !== "object" || row.facts === null) return null;
  for (const fact of Object.values(row.facts as Record<string, unknown>)) {
    if (fact !== null && !["string", "number", "boolean"].includes(typeof fact)) return null;
  }
  return value as PublicDrillReceipt;
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
): CriterionEvaluation {
  const id = "m0-foundation-reproducibility";
  const receiptPath = join(root, "data/acceptance/evidence/fresh-clone.json");
  let receiptValid = false;
  let receiptRuntimeValid = false;
  let receiptHash: string | undefined;
  if (existsSync(receiptPath)) {
    try {
      const receipt = validateFreshCloneReceipt(readJson(receiptPath));
      receiptValid = receipt.sourceCommit === evaluatedCommit;
      receiptRuntimeValid = /^v24\./u.test(receipt.runtimes.node)
        && /^11\./u.test(receipt.runtimes.npm)
        && ["setup", "smoke", "publication", "analysis"].every((id) =>
          receipt.checks.some((check) => check.id === id && check.exitCode === 0));
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
    nodeMajor24: runtimeOk,
    databaseQuickCheck: quickOk ? "ok" : "failed",
    foreignKeyViolations: foreignKeys,
    migrationCount: migrations,
  }, receiptHash);
  const passed = receiptValid && receiptRuntimeValid && runtimeOk && quickOk && foreignKeys === 0 && migrations >= 10;
  return {
    criterion: criterion(id, passed ? "pass" : "fail", passed
      ? "Clean-clone receipt, declared runtime, migrations, and read-only database checks pass"
      : "Foundation or clean-clone reproducibility evidence is missing or invalid",
    passed ? [] : [receiptValid ? "DATABASE_INTEGRITY_FAILED" : "REQUIRED_ARTIFACT_MISSING"], [evidenceId]),
    gates: [],
    evidence: [item],
  };
}

function m6Evaluation(root: string, command: CommandEvidence): CriterionEvaluation {
  const base = commandAcceptance("m6-index-analysis", command, "Golden index, official comparison, exports, and analysis checks pass");
  if (base.criterion.status === "fail") return base;
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
  }
  return base;
}

function timerDefinitionsSafe(root: string): boolean {
  return TIMER_UNITS.every((unit) => {
    const path = join(root, "ops", unit);
    if (!existsSync(path)) return false;
    const text = readFileSync(path, "utf8");
    return /OnCalendar=.*America\/Sao_Paulo/u.test(text)
      && /Persistent=true/u.test(text)
      && /RandomizedDelaySec=/u.test(text)
      && !/(?:OPENAI_API_KEY|CODEX_API_KEY|NTFY_TOPIC)\s*=/u.test(text);
  });
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
  const alert = readDrillReceipt(alertPath);
  const backup = readDrillReceipt(backupPath);
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
  const timerDefinitionsValid = timerDefinitionsSafe(root);
  const latestHeartbeat = database.prepare(`
    SELECT completed_at FROM heartbeats
    WHERE pipeline = 'collect' AND status = 'completed'
    ORDER BY completed_at DESC, id DESC LIMIT 1
  `).get() as { completed_at: string } | undefined;
  const heartbeatAgeHours = latestHeartbeat === undefined
    ? null
    : (now.getTime() - Date.parse(latestHeartbeat.completed_at)) / 3_600_000;
  const heartbeatFresh = heartbeatAgeHours !== null && Number.isFinite(heartbeatAgeHours) && heartbeatAgeHours <= 24;
  let backupFileHealthy = false;
  let backupAgeHours: number | null = null;
  if (backup?.facts.backupPath !== undefined && typeof backup.facts.backupPath === "string") {
    const candidate = resolve(root, backup.facts.backupPath);
    if (candidate.startsWith(`${root}${sep}`) && existsSync(candidate)) {
      const metadata = statSync(candidate);
      backupAgeHours = (now.getTime() - metadata.mtimeMs) / 3_600_000;
      try {
        const backupDatabase = new Database(candidate, { readonly: true, fileMustExist: true });
        const quick = backupDatabase.pragma("quick_check") as Array<Record<string, unknown>>;
        const foreignKeys = backupDatabase.pragma("foreign_key_check") as unknown[];
        backupDatabase.close();
        backupFileHealthy = (metadata.mode & 0o777) === 0o600
          && quick.length === 1 && Object.values(quick[0] ?? {})[0] === "ok"
          && foreignKeys.length === 0 && backupAgeHours <= 26;
      } catch {
        backupFileHealthy = false;
      }
    }
  }
  const evidenceId = "service-m7-publication-operations";
  const item = evidence(evidenceId, "service", "m7-publication-and-six-timers", now.toISOString(), {
    publicationPassed: publication.status === "pass",
    publicationFindings: publication.findings.length,
    freshCloneMatches: freshMatches,
    sixTimersEnabledAndActive: timersHealthy,
    timerDefinitionsValid,
    alertDrillMatches: alertMatches,
    backupDrillMatches: backupMatches,
    backupIntegrityAndAgeValid: backupFileHealthy,
    backupAgeHours,
    latestCollectionHeartbeatFresh: heartbeatFresh,
    latestCollectionHeartbeatAgeHours: heartbeatAgeHours,
  });
  if (publication.status === "fail") {
    return { criterion: criterion(id, "fail", "Publication audit reports a public safety defect", ["SECRET_OR_PRIVATE_ARTIFACT"], [evidenceId]), gates: [], evidence: [item] };
  }
  if (!timersHealthy || !timerDefinitionsValid || (alert !== null && !alertMatches) || (backup !== null && (!backupMatches || !backupFileHealthy)) || !freshMatches) {
    return { criterion: criterion(id, "fail", "Required static operations, receipt integrity, or timer evidence is invalid", ["EVIDENCE_CONTRADICTION"], [evidenceId]), gates: [], evidence: [item] };
  }
  if (alert === null || backup === null) {
    return {
      criterion: criterion(id, "pending", "Explicit safe production drills await author execution", ["AUTHORITY_APPROVAL_REQUIRED"], [evidenceId]),
      gates: [gate(id, "authority", "AUTHORITY_APPROVAL_REQUIRED", null, "Run both explicit safe drills after reviewing their production target", "npm run acceptance:drill -- alert --confirm-safe-drill --json && npm run acceptance:drill -- backup --confirm-safe-drill --json", [evidenceId])],
      evidence: [item],
    };
  }
  if (!heartbeatFresh) {
    const reason = latestHeartbeat === undefined ? "SCHEDULED_RUN_NOT_YET_DUE" : "MISSED_SCHEDULED_RUN";
    if (latestHeartbeat !== undefined) {
      return { criterion: criterion(id, "fail", "The latest real collection heartbeat is older than 24 hours", [reason], [evidenceId]), gates: [], evidence: [item] };
    }
    return {
      criterion: criterion(id, "pending", "The first daily collection window has not produced heartbeat evidence", [reason], [evidenceId]),
      gates: [gate(id, "time", reason, null, "Let the installed daily timer reach its first real window", "npm run acceptance -- --json", [evidenceId])], evidence: [item],
    };
  }
  return { criterion: criterion(id, "pass", "Publication, six timers, safe drills, backup, and heartbeat evidence are current", [], [evidenceId]), gates: [], evidence: [item] };
}

export async function buildAcceptanceReport(options: AcceptanceOptions): Promise<AcceptanceReport> {
  const root = realpathSync(options.projectRoot);
  const databasePath = realpathSync(options.databasePath);
  const evaluatedCommit = git(root, ["rev-parse", "HEAD"]);
  if (!COMMIT.test(evaluatedCommit)) throw new Error("Acceptance requires a Git implementation commit");
  const now = options.now();
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const [m1Command, m5Command, m6Command, services, publication] = await Promise.all([
      options.runCommand("m1-offline", "npm", ["test", "--", "tests/normalize", "tests/strategies", "tests/collection", "tests/discovery", "tests/pipeline/collect.test.ts", "tests/pipeline/discover.test.ts"]),
      options.runCommand("m5-healing", "npm", ["test", "--", "tests/healing", "tests/ops/systemd.test.ts"]),
      options.runCommand("m6-index-analysis", "npm", ["test", "--", "tests/index", "tests/analysis"]),
      options.serviceReader.read([...TIMER_UNITS]),
      auditPublication({ projectRoot: root, databasePath, now: options.now, requireClean: false }),
    ]);
    const m0 = m0Evaluation(root, database, evaluatedCommit, now);
    const m1 = commandAcceptance("m1-offline-determinism", m1Command, "Offline normalization, extraction, discovery, and retailer safety suites pass");
    const m2 = evaluateM2(database, now);
    const m3 = evaluateM3(database, {
      credentialConfigured: options.credentialConfigured ?? false,
      siteValidated: options.siteValidated ?? false,
      authorityApproved: options.authorityApproved ?? false,
    }, now);
    const m4 = evaluateM4(database, {
      credentialConfigured: options.credentialConfigured ?? false,
      spendAuthorized: options.spendAuthorized ?? false,
      siteValidated: options.siteValidated ?? false,
    }, now);
    const m5 = commandAcceptance("m5-automatic-healing", m5Command, "Isolated sabotage, drift/blocking, recovery, and timer suites pass");
    const healingTimer = services.find((service) => service.unit === "precos-healing.timer");
    if (m5.criterion.status === "pass" && (healingTimer?.enabled !== true || healingTimer.active !== true)) {
      m5.criterion = criterion("m5-automatic-healing", "fail", "Healing tests pass but the independent worker timer is not enabled and active", ["UNSAFE_CONFIGURATION"], m5.criterion.evidenceIds);
    }
    const m6 = m6Evaluation(root, m6Command);
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
    const databaseSha256 = hash(database.serialize());
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

export async function verifyAcceptanceSnapshot(
  projectRoot: string,
  snapshotPath: string,
): Promise<SnapshotVerification> {
  const root = realpathSync(projectRoot);
  const report = readJson(snapshotPath) as Partial<AcceptanceReport> | null;
  const headCommit = git(root, ["rev-parse", "HEAD"]);
  const evaluatedCommit = typeof report?.evaluatedCommit === "string" ? report.evaluatedCommit : "";
  const reasonCodes: string[] = [];
  if (!COMMIT.test(evaluatedCommit) || !gitSucceeds(root, ["merge-base", "--is-ancestor", evaluatedCommit, headCommit])) {
    reasonCodes.push("EVIDENCE_CONTRADICTION");
  }
  const changedPaths = COMMIT.test(evaluatedCommit)
    ? git(root, ["diff", "--name-only", `${evaluatedCommit}..${headCommit}`]).split("\n").filter(Boolean).sort()
    : [];
  if (changedPaths.some((path) => !allowedEvidencePath(path))) reasonCodes.push("REQUIRED_ARTIFACT_MISSING");
  return {
    status: reasonCodes.length === 0 ? "pass" : "fail",
    evaluatedCommit,
    headCommit,
    changedPaths,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}
