import type Database from "better-sqlite3";

import {
  DAILY_NETWORK_REQUEST_BUDGET,
  DAILY_REPLAY_ADMISSION_BUDGET,
  DISCOVERY_REFERENCE_BUDGET,
  discoveryReferenceAdmissionsForDay,
  replaySlotAdmissionsForDay,
  requestAdmissionsForDay,
} from "../../../../../src/db/repositories.js";
import { assessRunHealth } from "../../../../../src/healing/classify-failure.js";
import {
  buildDailyIndex,
  experimentalDailySeriesFacts,
} from "../../../../../src/index/aggregate.js";
import { INDEX_METHOD_VERSION } from "../../../../../src/index/types.js";
import { checkHeartbeat } from "../../../../../src/ops/heartbeat.js";
import type { FailureCategory } from "../../../../../src/strategies/types.js";
import type {
  AutomationResponse,
  IndexResponse,
  LimitsResponse,
  OverviewResponse,
  RetailerDetailResponse,
  RetailerSummary,
  RetailersResponse,
  RunDetailResponse,
  RunSummary,
  RunsResponse,
  StrategySummary,
} from "../../shared/contracts.js";
import type { ReadSnapshotContext } from "./database.js";

interface RunRow {
  id: string;
  retailer_id: string;
  retailer_name: string;
  stage: string;
  collection_day: string;
  strategy_id: string | null;
  strategy_version: number | null;
  status: string;
  attempted: number;
  ok: number;
  failed: number;
  started_at: string;
  finished_at: string | null;
  metadata_json: string | null;
  reconciled: number;
}

interface FailureGroupRow {
  run_id: string;
  category: string;
  responded: number;
  count: number;
}

interface RetailerRow {
  id: string;
  name: string;
  cep: string;
  platform_hint: string | null;
  active: number;
  degraded: number;
  degraded_reason: string | null;
  products_total: number;
  products_active: number;
  products_in_scope: number;
  products_observed: number;
  products_classified: number;
}

interface CatalogSnapshotRow {
  retailer_id: string;
  complete: number;
  completion_reason: string;
  discovered: number;
  in_scope: number;
  out_of_scope: number;
  disappeared: number;
  completed_at: string;
}

interface SafeRunMetadata {
  planned: number | null;
  skipped: number | null;
  stoppedForBlocking: boolean;
}

function finiteNonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function parseRunMetadata(value: string | null): SafeRunMetadata {
  if (value === null) return { planned: null, skipped: null, stoppedForBlocking: false };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      planned: finiteNonnegativeInteger(parsed.planned),
      skipped: finiteNonnegativeInteger(parsed.skipped),
      stoppedForBlocking: parsed.stoppedForBlocking === true,
    };
  } catch {
    return { planned: null, skipped: null, stoppedForBlocking: false };
  }
}

function safeOperationalText(value: string | null, maximum = 240): string | null {
  if (value === null || value.trim() === "") return null;
  return value
    .replace(/https?:\/\/\S+/giu, "[endereço omitido]")
    .replace(/(?:^|\s)(?:\/(?:home|root|tmp|var|etc)\/\S+|[A-Za-z]:\\\S+)/gu, " [caminho omitido]")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

const sourceCutoffCache = new WeakMap<
  Database.Database,
  { dataVersion: number; value: string | null }
>();

function sourceCutoff(context: ReadSnapshotContext): string | null {
  const cached = sourceCutoffCache.get(context.database);
  if (cached?.dataVersion === context.dataVersion) return cached.value;
  const row = context.database.prepare(`
    SELECT MAX(source_at) AS source_at
    FROM (
      SELECT MAX(COALESCE(finished_at, started_at, created_at)) AS source_at FROM runs
      UNION ALL SELECT MAX(observed_at) FROM observations
      UNION ALL SELECT MAX(created_at) FROM classifications
      UNION ALL SELECT MAX(COALESCE(recovered_at, detected_at, created_at)) FROM healing_events
      UNION ALL SELECT MAX(completed_at) FROM heartbeats
      UNION ALL SELECT MAX(occurred_at) FROM cost_ledger
    )
  `).get() as { source_at: string | null };
  sourceCutoffCache.set(context.database, {
    dataVersion: context.dataVersion,
    value: row.source_at,
  });
  return row.source_at;
}

function envelope(context: ReadSnapshotContext, cutoff = sourceCutoff(context)) {
  return {
    generatedAt: context.generatedAt,
    sourceCutoffAt: cutoff,
    dataVersion: context.dataVersion,
    schemaCapability: context.schemaCapability,
  };
}

function lifecycle(status: string): RunSummary["lifecycle"] {
  return status === "running" || status === "completed" || status === "partial" || status === "failed"
    ? status
    : "unknown";
}

function failureGroups(
  database: Database.Database,
  runIds: readonly string[],
): Map<string, FailureGroupRow[]> {
  if (runIds.length === 0) return new Map();
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT run_id, category, responded, COUNT(*) AS count
    FROM run_failures
    WHERE run_id IN (${placeholders})
    GROUP BY run_id, category, responded
    ORDER BY run_id, count DESC, category
  `).all(...runIds) as FailureGroupRow[];
  const grouped = new Map<string, FailureGroupRow[]>();
  for (const row of rows) {
    const values = grouped.get(row.run_id) ?? [];
    values.push(row);
    grouped.set(row.run_id, values);
  }
  return grouped;
}

function runSummary(row: RunRow, failures: readonly FailureGroupRow[]): RunSummary {
  const metadata = parseRunMetadata(row.metadata_json);
  const runLifecycle = lifecycle(row.status);
  let health: RunSummary["health"] = "unknown";
  if (
    runLifecycle !== "running"
    && row.attempted > 0
    && row.attempted === row.ok + row.failed
  ) {
    const evidence = failures.flatMap((failure) => Array.from(
      { length: Math.min(failure.count, row.failed) },
      () => ({
        category: failure.category as FailureCategory,
        responded: failure.responded === 1,
      }),
    ));
    health = assessRunHealth({
      attempted: row.attempted,
      ok: row.ok,
      failed: row.failed,
      status: row.status,
      stoppedForBlocking: metadata.stoppedForBlocking,
    }, evidence).health;
  }

  const constraint: RunSummary["constraint"] = metadata.stoppedForBlocking
    ? "blocking_stop"
    : runLifecycle === "partial" && (metadata.skipped !== null || metadata.planned !== null)
      ? "bounded"
      : runLifecycle === "partial"
        ? "incomplete_evidence"
        : runLifecycle === "completed" || runLifecycle === "running"
          ? "none"
          : "unknown";
  const dominantFailure = failures[0];

  return {
    id: row.id,
    retailerId: row.retailer_id,
    retailerName: row.retailer_name,
    stage: row.stage === "discover" ? "discover" : "collect",
    collectionDay: row.collection_day,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    lifecycle: runLifecycle,
    health,
    constraint,
    attempted: row.attempted,
    ok: row.ok,
    failed: row.failed,
    planned: metadata.planned,
    skipped: metadata.skipped,
    successRate: row.attempted === 0 ? null : row.ok / row.attempted,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    dominantFailureCategory: dominantFailure?.category ?? null,
    reconciled: row.reconciled === 1,
  };
}

function summarizeRuns(database: Database.Database, rows: readonly RunRow[]): RunSummary[] {
  const groups = failureGroups(database, rows.map(({ id }) => id));
  return rows.map((row) => runSummary(row, groups.get(row.id) ?? []));
}

function latestRunRows(database: Database.Database, retailerId?: string): RunRow[] {
  return database.prepare(`
    SELECT run.id, run.retailer_id, retailer.name AS retailer_name,
           run.stage, run.collection_day, run.strategy_id, run.strategy_version,
           run.status, run.attempted, run.ok, run.failed, run.started_at,
           run.finished_at, run.metadata_json,
           EXISTS(SELECT 1 FROM runtime_reconciliations reconciliation
                  WHERE reconciliation.kind = 'pipeline-run'
                    AND reconciliation.subject_id = run.id) AS reconciled
    FROM runs run
    JOIN retailers retailer ON retailer.id = run.retailer_id
    WHERE (? IS NULL OR run.retailer_id = ?)
      AND run.id = (
      SELECT candidate.id
      FROM runs candidate
      WHERE candidate.retailer_id = run.retailer_id
        AND candidate.stage = 'collect'
      ORDER BY candidate.collection_day DESC,
               COALESCE(candidate.finished_at, candidate.started_at) DESC,
               candidate.id DESC
      LIMIT 1
    )
    ORDER BY retailer.name COLLATE NOCASE, retailer.id
  `).all(retailerId ?? null, retailerId ?? null) as RunRow[];
}

function retailerRows(database: Database.Database, retailerId?: string): RetailerRow[] {
  return database.prepare(`
    SELECT retailer.id, retailer.name, retailer.cep, retailer.platform_hint,
           retailer.active, retailer.degraded, retailer.degraded_reason,
           COUNT(product.id) AS products_total,
           COALESCE(SUM(CASE WHEN product.active = 1 THEN 1 ELSE 0 END), 0) AS products_active,
           COALESCE(SUM(CASE WHEN product.in_scope = 1 THEN 1 ELSE 0 END), 0) AS products_in_scope,
           COALESCE(SUM(CASE WHEN product.last_observed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS products_observed,
           COALESCE(SUM(CASE WHEN product.current_ipca_item_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS products_classified
    FROM retailers retailer
    LEFT JOIN products product ON product.retailer_id = retailer.id
    WHERE (? IS NULL OR retailer.id = ?)
    GROUP BY retailer.id
    ORDER BY retailer.name COLLATE NOCASE, retailer.id
  `).all(retailerId ?? null, retailerId ?? null) as RetailerRow[];
}

function latestCatalogSnapshots(
  database: Database.Database,
  retailerId?: string,
): Map<string, CatalogSnapshotRow> {
  const rows = database.prepare(`
    SELECT snapshot.retailer_id, snapshot.complete, snapshot.completion_reason,
           snapshot.discovered, snapshot.in_scope, snapshot.out_of_scope,
           snapshot.disappeared, snapshot.completed_at
    FROM catalog_snapshots snapshot
    WHERE (? IS NULL OR snapshot.retailer_id = ?)
      AND snapshot.run_id = (
      SELECT candidate.run_id
      FROM catalog_snapshots candidate
      WHERE candidate.retailer_id = snapshot.retailer_id
      ORDER BY candidate.completed_at DESC, candidate.run_id DESC
      LIMIT 1
    )
  `).all(retailerId ?? null, retailerId ?? null) as CatalogSnapshotRow[];
  return new Map(rows.map((row) => [row.retailer_id, row]));
}

function retailerSummaries(
  database: Database.Database,
  retailerId?: string,
): RetailerSummary[] {
  const latestRuns = new Map(
    summarizeRuns(database, latestRunRows(database, retailerId))
      .map((run) => [run.retailerId, run]),
  );
  const snapshots = latestCatalogSnapshots(database, retailerId);
  return retailerRows(database, retailerId).map((row) => {
    const snapshot = snapshots.get(row.id);
    return {
      id: row.id,
      name: row.name,
      cep: row.cep,
      platformHint: row.platform_hint,
      active: row.active === 1,
      degraded: row.degraded === 1,
      degradedReason: safeOperationalText(row.degraded_reason),
      products: {
        total: row.products_total,
        active: row.products_active,
        inScope: row.products_in_scope,
        observed: row.products_observed,
        classified: row.products_classified,
      },
      latestRun: latestRuns.get(row.id) ?? null,
      latestCatalogSnapshot: snapshot === undefined
        ? null
        : {
            complete: snapshot.complete === 1,
            completionReason: snapshot.completion_reason,
            discovered: snapshot.discovered,
            inScope: snapshot.in_scope,
            outOfScope: snapshot.out_of_scope,
            disappeared: snapshot.complete === 1 ? snapshot.disappeared : null,
            completedAt: snapshot.completed_at,
          },
    };
  });
}

function recentRunRows(
  database: Database.Database,
  options: {
    retailerId?: string;
    stage?: "discover" | "collect";
    status?: string;
    limit: number;
    offset: number;
  },
): RunRow[] {
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];
  if (options.retailerId !== undefined) {
    clauses.push("run.retailer_id = ?");
    parameters.push(options.retailerId);
  }
  if (options.stage !== undefined) {
    clauses.push("run.stage = ?");
    parameters.push(options.stage);
  }
  if (options.status !== undefined) {
    clauses.push("run.status = ?");
    parameters.push(options.status);
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  return database.prepare(`
    SELECT run.id, run.retailer_id, retailer.name AS retailer_name,
           run.stage, run.collection_day, run.strategy_id, run.strategy_version,
           run.status, run.attempted, run.ok, run.failed, run.started_at,
           run.finished_at, run.metadata_json,
           EXISTS(SELECT 1 FROM runtime_reconciliations reconciliation
                  WHERE reconciliation.kind = 'pipeline-run'
                    AND reconciliation.subject_id = run.id) AS reconciled
    FROM runs run
    JOIN retailers retailer ON retailer.id = run.retailer_id
    ${where}
    ORDER BY run.collection_day DESC,
             COALESCE(run.finished_at, run.started_at) DESC,
             run.id DESC
    LIMIT ? OFFSET ?
  `).all(...parameters, options.limit, options.offset) as RunRow[];
}

function runCount(
  database: Database.Database,
  options: { retailerId?: string; stage?: "discover" | "collect"; status?: string },
): number {
  const clauses: string[] = [];
  const parameters: string[] = [];
  if (options.retailerId !== undefined) {
    clauses.push("retailer_id = ?");
    parameters.push(options.retailerId);
  }
  if (options.stage !== undefined) {
    clauses.push("stage = ?");
    parameters.push(options.stage);
  }
  if (options.status !== undefined) {
    clauses.push("status = ?");
    parameters.push(options.status);
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  return (database.prepare(`SELECT COUNT(*) AS count FROM runs ${where}`)
    .get(...parameters) as { count: number }).count;
}

function strategySummaries(database: Database.Database, retailerId?: string): StrategySummary[] {
  const rows = database.prepare(`
    SELECT strategy.id, strategy.retailer_id, strategy.purpose, strategy.tier,
           strategy.version, strategy.provenance, strategy.model,
           strategy.prompt_version, strategy.active,
           strategy.validation_sample_size, strategy.validation_successes,
           strategy.validation_rate, strategy.validated_at, strategy.activated_at,
           strategy.retired_at,
           CASE WHEN evidence.strategy_id IS NULL THEN 0 ELSE 1 END AS signed_evidence,
           evidence.attempted AS evidence_attempted,
           evidence.valid AS evidence_valid,
           evidence.score AS evidence_score,
           evidence.validated_at AS evidence_validated_at
    FROM strategies strategy
    LEFT JOIN strategy_validation_evidence evidence ON evidence.strategy_id = strategy.id
    WHERE (? IS NULL OR strategy.retailer_id = ?)
    ORDER BY strategy.retailer_id, strategy.purpose,
             strategy.active DESC, strategy.version DESC
  `).all(retailerId ?? null, retailerId ?? null) as Array<{
    id: string;
    retailer_id: string;
    purpose: "discovery" | "extraction";
    tier: number;
    version: number;
    provenance: string;
    model: string | null;
    prompt_version: string | null;
    active: number;
    validation_sample_size: number;
    validation_successes: number;
    validation_rate: number | null;
    validated_at: string | null;
    activated_at: string | null;
    retired_at: string | null;
    signed_evidence: number;
    evidence_attempted: number | null;
    evidence_valid: number | null;
    evidence_score: number | null;
    evidence_validated_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    retailerId: row.retailer_id,
    purpose: row.purpose,
    tier: row.tier,
    version: row.version,
    provenance: row.provenance,
    model: row.model,
    promptVersion: row.prompt_version,
    active: row.active === 1,
    validation: {
      attempted: row.evidence_attempted ?? row.validation_sample_size,
      valid: row.evidence_valid ?? row.validation_successes,
      score: row.evidence_score ?? row.validation_rate,
      signedEvidence: row.signed_evidence === 1,
      validatedAt: row.evidence_validated_at ?? row.validated_at,
    },
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
  }));
}

function classificationFacts(database: Database.Database) {
  const latest = database.prepare(
    "SELECT MAX(version) AS version FROM classifications",
  ).get() as { version: number | null };
  const version = latest.version;
  const rows = database.prepare(`
    SELECT retailer.id AS retailer_id, retailer.name AS retailer_name,
           COALESCE(SUM(CASE WHEN product.active = 1 AND product.in_scope = 1
                                  AND product.descriptive_title = 1 THEN 1 ELSE 0 END), 0) AS eligible,
           COALESCE(SUM(CASE WHEN product.active = 1 AND product.in_scope = 1
                                  AND product.descriptive_title = 1
                                  AND classification.ipca_item_id IS NOT NULL
                             THEN 1 ELSE 0 END), 0) AS assigned,
           COALESCE(SUM(CASE WHEN product.active = 1 AND product.in_scope = 1
                                  AND product.descriptive_title = 1
                                  AND decision.action = 'excluded'
                             THEN 1 ELSE 0 END), 0) AS excluded,
           COALESCE(SUM(CASE WHEN product.active = 1 AND product.in_scope = 1
                                  AND product.descriptive_title = 1
                                  AND classification.id IS NULL
                             THEN 1 ELSE 0 END), 0) AS pending
    FROM retailers retailer
    LEFT JOIN products product ON product.retailer_id = retailer.id
    LEFT JOIN classifications classification
      ON classification.product_id = product.id
     AND classification.version = COALESCE(?, 1)
    LEFT JOIN classification_scope_decisions decision
      ON decision.product_id = product.id
     AND decision.classification_version = COALESCE(?, 1)
    GROUP BY retailer.id
    ORDER BY retailer.name COLLATE NOCASE, retailer.id
  `).all(version, version) as Array<{
    retailer_id: string;
    retailer_name: string;
    eligible: number;
    assigned: number;
    excluded: number;
    pending: number;
  }>;
  return {
    latestVersion: version,
    byRetailer: rows.map((row) => ({
      retailerId: row.retailer_id,
      retailerName: row.retailer_name,
      eligible: row.eligible,
      assigned: row.assigned,
      excluded: row.excluded,
      pending: row.pending,
    })),
    eligible: rows.reduce((sum, row) => sum + row.eligible, 0),
    assigned: rows.reduce((sum, row) => sum + row.assigned, 0),
    excluded: rows.reduce((sum, row) => sum + row.excluded, 0),
    pending: rows.reduce((sum, row) => sum + row.pending, 0),
  };
}

function latestScheduledHeartbeat(database: Database.Database): {
  completedAt: string | null;
  releaseId: string | null;
  retailerCount: number | null;
  failedRetailerCount: number | null;
} {
  const row = database.prepare(`
    SELECT completed_at, details_json
    FROM heartbeats
    WHERE pipeline = 'collect'
      AND json_valid(details_json)
      AND json_extract(details_json, '$.trigger') = 'systemd-timer'
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `).get() as { completed_at: string; details_json: string } | undefined;
  if (row === undefined) {
    return {
      completedAt: null,
      releaseId: null,
      retailerCount: null,
      failedRetailerCount: null,
    };
  }
  try {
    const details = JSON.parse(row.details_json) as Record<string, unknown>;
    return {
      completedAt: row.completed_at,
      releaseId: typeof details.releaseId === "string" ? details.releaseId : null,
      retailerCount: Array.isArray(details.retailerIds) ? details.retailerIds.length : null,
      failedRetailerCount: Array.isArray(details.retailerFailures)
        ? details.retailerFailures.length
        : null,
    };
  } catch {
    return {
      completedAt: row.completed_at,
      releaseId: null,
      retailerCount: null,
      failedRetailerCount: null,
    };
  }
}

export function readOverview(context: ReadSnapshotContext): OverviewResponse {
  const { database } = context;
  const retailers = retailerSummaries(database);
  const recentRuns = summarizeRuns(database, recentRunRows(database, { limit: 8, offset: 0 }));
  const classification = classificationFacts(database);
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM observations) AS observations,
      (SELECT COUNT(*) FROM runs) AS runs,
      (SELECT COUNT(*) FROM healing_events
       WHERE status NOT IN ('recovered', 'failed', 'completed', 'cancelled')) AS open_healing
  `).get() as {
    products: number;
    observations: number;
    runs: number;
    open_healing: number;
  };
  const heartbeat = latestScheduledHeartbeat(database);
  const heartbeatCheck = checkHeartbeat(
    new Date(context.generatedAt),
    heartbeat.completedAt === null ? null : new Date(heartbeat.completedAt),
  );
  const heartbeatStatus = heartbeat.completedAt === null
    ? "missing" as const
    : heartbeatCheck.stale
      ? "stale" as const
      : "fresh" as const;
  const degraded = retailers.filter((retailer) => retailer.degraded);
  const active = retailers.filter((retailer) => retailer.active);
  const latestCollectRuns = active.map(({ latestRun }) => latestRun).filter(
    (run): run is RunSummary => run !== null,
  );
  const attention: OverviewResponse["attention"] = [];
  for (const retailer of degraded) {
    attention.push({
      id: `degraded:${retailer.id}`,
      severity: "critical",
      kind: "retailer_degraded",
      title: `${retailer.name} está degradado`,
      detail: retailer.degradedReason ?? "O estado degradado foi registrado sem detalhe público.",
      route: `/retailers/${encodeURIComponent(retailer.id)}`,
      occurredAt: retailer.latestRun?.finishedAt ?? null,
    });
  }
  if (heartbeatStatus !== "fresh") {
    attention.push({
      id: "scheduled-heartbeat",
      severity: heartbeatStatus === "missing" ? "critical" : "warning",
      kind: "scheduled_heartbeat",
      title: heartbeatStatus === "missing"
        ? "Nenhum heartbeat agendado foi comprovado"
        : "O heartbeat da coleta agendada está atrasado",
      detail: "Execuções manuais não substituem a evidência do timer do systemd.",
      route: "/system",
      occurredAt: heartbeat.completedAt,
    });
  }
  for (const run of latestCollectRuns.filter((candidate) =>
    candidate.health === "blocking" || candidate.health === "drift" || candidate.health === "mixed")) {
    attention.push({
      id: `run-health:${run.id}`,
      severity: run.health === "blocking" ? "critical" : "warning",
      kind: `run_${run.health}`,
      title: `${run.retailerName}: ${run.health}`,
      detail: `A execução mais recente terminou com ${run.ok}/${run.attempted} coletas válidas.`,
      route: `/runs/${encodeURIComponent(run.id)}`,
      occurredAt: run.finishedAt,
    });
  }
  if (counts.open_healing > 0) {
    attention.push({
      id: "open-healing",
      severity: "warning",
      kind: "open_healing",
      title: `${counts.open_healing} evento(s) de healing ainda aberto(s)`,
      detail: "O modelo só pode propor uma estratégia; a ativação continua sujeita à validação assinada.",
      route: "/automation",
      occurredAt: null,
    });
  }
  if (classification.pending > 0) {
    attention.push({
      id: "classification-pending",
      severity: "info",
      kind: "classification_pending",
      title: `${classification.pending} produto(s) elegível(is) aguardam classificação`,
      detail: "A coleta determinística continua funcionando mesmo quando o provedor de modelo está indisponível.",
      route: "/automation",
      occurredAt: null,
    });
  }

  const discoveryLatest = database.prepare(`
    SELECT status, COUNT(*) AS count
    FROM runs
    WHERE stage = 'discover'
      AND id IN (
        SELECT id FROM runs candidate
        WHERE candidate.stage = 'discover'
          AND candidate.id = (
            SELECT nested.id FROM runs nested
            WHERE nested.retailer_id = candidate.retailer_id
              AND nested.stage = 'discover'
            ORDER BY nested.collection_day DESC,
                     COALESCE(nested.finished_at, nested.started_at) DESC,
                     nested.id DESC LIMIT 1
          )
      )
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>;
  const hasRunningDiscovery = discoveryLatest.some((row) => row.status === "running");
  const hasProblemDiscovery = discoveryLatest.some((row) => row.status === "failed");
  const hasRunningCollection = latestCollectRuns.some((run) => run.lifecycle === "running");
  const hasCollectionAttention = latestCollectRuns.some((run) => run.health !== "healthy" && run.health !== "unknown");
  const activeStrategies = database.prepare(
    "SELECT COUNT(*) AS count FROM strategies WHERE active = 1",
  ).get() as { count: number };
  const runningReservations = database.prepare(`
    SELECT COUNT(*) AS count
    FROM classification_sync_reservations
    WHERE status NOT IN ('settled', 'recovered', 'released', 'failed')
  `).get() as { count: number };

  return {
    ...envelope(context),
    totals: {
      retailers: retailers.length,
      activeRetailers: active.length,
      degradedRetailers: degraded.length,
      products: counts.products,
      observations: counts.observations,
      runs: counts.runs,
      pendingClassification: classification.pending,
      openHealingEvents: counts.open_healing,
    },
    scheduledHeartbeat: {
      status: heartbeatStatus,
      completedAt: heartbeat.completedAt,
      releaseId: heartbeat.releaseId,
      retailerCount: heartbeat.retailerCount,
      failedRetailerCount: heartbeat.failedRetailerCount,
    },
    pipeline: [
      {
        id: "registry",
        state: retailers.length === 0 ? "empty" : activeStrategies.count === 0 ? "waiting" : "ready",
        label: "Varejistas e estratégias",
        detail: `${active.length} varejista(s) ativo(s); ${activeStrategies.count} estratégia(s) ativa(s).`,
        count: retailers.length,
        route: "/retailers",
      },
      {
        id: "discovery",
        state: hasRunningDiscovery ? "running" : hasProblemDiscovery ? "attention" : discoveryLatest.length === 0 ? "empty" : "ready",
        label: "Descoberta",
        detail: "Enumera referências e registra decisões de escopo antes da coleta.",
        count: discoveryLatest.reduce((sum, row) => sum + row.count, 0),
        route: "/runs?stage=discover",
      },
      {
        id: "catalog",
        state: counts.products === 0 ? "empty" : retailers.some((retailer) =>
          retailer.latestCatalogSnapshot !== null && !retailer.latestCatalogSnapshot.complete)
          ? "waiting"
          : "ready",
        label: "Catálogo",
        detail: "Snapshots incompletos nunca provam desaparecimento de produtos.",
        count: counts.products,
        route: "/retailers",
      },
      {
        id: "collection",
        state: hasRunningCollection ? "running" : hasCollectionAttention ? "attention" : latestCollectRuns.length === 0 ? "empty" : "ready",
        label: "Coleta",
        detail: "Executa estratégias tipadas e persiste observações ou falhas categorizadas.",
        count: counts.observations,
        route: "/runs?stage=collect",
      },
      {
        id: "monitor",
        state: counts.open_healing > 0 ? "attention" : latestCollectRuns.length === 0 ? "waiting" : "ready",
        label: "Monitor de drift",
        detail: "Separa drift de bloqueio antes de autorizar qualquer gasto com modelo.",
        count: latestCollectRuns.length,
        route: "/automation",
      },
      {
        id: "healing",
        state: counts.open_healing > 0 ? "attention" : "waiting",
        label: "Healing",
        detail: "Candidatos só ativam após 27/30 resultados válidos e recibo assinado.",
        count: counts.open_healing,
        route: "/automation",
      },
      {
        id: "classification",
        state: runningReservations.count > 0 ? "running" : classification.pending > 0 ? "attention" : classification.eligible === 0 ? "empty" : "ready",
        label: "Classificação IPCA",
        detail: "Decisões versionadas preservam confiança, custo e abstinências.",
        count: classification.assigned,
        route: "/automation",
      },
      {
        id: "index",
        state: counts.observations === 0 || classification.assigned === 0 ? "waiting" : "ready",
        label: "Índice experimental",
        detail: "Calculado ao vivo; snapshots publicados permanecem cortes históricos separados.",
        count: null,
        route: "/index",
      },
    ],
    attention,
    retailers,
    recentRuns,
  };
}

export function readRetailers(context: ReadSnapshotContext): RetailersResponse {
  return { ...envelope(context), retailers: retailerSummaries(context.database) };
}

function admissionUsage(
  database: Database.Database,
  retailerId: string,
): RetailerDetailResponse["admissions"] {
  const dayRow = database.prepare(`
    SELECT MAX(collection_day) AS day
    FROM (
      SELECT collection_day FROM request_admissions WHERE retailer_id = ?
      UNION ALL SELECT collection_day FROM discovery_reference_admissions WHERE retailer_id = ?
      UNION ALL SELECT collection_day FROM replay_slot_admissions WHERE retailer_id = ?
    )
  `).get(retailerId, retailerId, retailerId) as { day: string | null };
  const day = dayRow.day;
  const counts = day === null
    ? { network: 0, discovery: 0, replay: 0 }
    : {
        network: requestAdmissionsForDay(database, retailerId, day),
        discovery: discoveryReferenceAdmissionsForDay(database, retailerId, day),
        replay: replaySlotAdmissionsForDay(database, retailerId, day),
      };
  return [
    {
      kind: "network",
      day,
      used: counts.network,
      limit: DAILY_NETWORK_REQUEST_BUDGET,
      remaining: Math.max(0, DAILY_NETWORK_REQUEST_BUDGET - counts.network),
    },
    {
      kind: "discovery_reference",
      day,
      used: counts.discovery,
      limit: DISCOVERY_REFERENCE_BUDGET,
      remaining: Math.max(0, DISCOVERY_REFERENCE_BUDGET - counts.discovery),
    },
    {
      kind: "replay",
      day,
      used: counts.replay,
      limit: DAILY_REPLAY_ADMISSION_BUDGET,
      remaining: Math.max(0, DAILY_REPLAY_ADMISSION_BUDGET - counts.replay),
    },
  ];
}

export function readRetailerDetail(
  context: ReadSnapshotContext,
  retailerId: string,
): RetailerDetailResponse | null {
  const retailer = retailerSummaries(context.database, retailerId).at(0);
  if (retailer === undefined) return null;
  const recentRuns = summarizeRuns(
    context.database,
    recentRunRows(context.database, { retailerId, limit: 12, offset: 0 }),
  );
  const stateRows = context.database.prepare(`
    SELECT state, purpose, reason, source, effective_at
    FROM retailer_state_events
    WHERE retailer_id = ?
    ORDER BY effective_at DESC, sequence DESC
    LIMIT 30
  `).all(retailerId) as Array<{
    state: string;
    purpose: string | null;
    reason: string;
    source: string;
    effective_at: string;
  }>;
  return {
    ...envelope(context),
    retailer,
    strategies: strategySummaries(context.database, retailerId),
    admissions: admissionUsage(context.database, retailerId),
    recentRuns,
    stateEvents: stateRows.map((row) => ({
      state: row.state,
      purpose: row.purpose,
      reason: safeOperationalText(row.reason) ?? "Sem detalhe público.",
      source: row.source,
      effectiveAt: row.effective_at,
    })),
  };
}

export function readRuns(
  context: ReadSnapshotContext,
  options: {
    retailerId?: string;
    stage?: "discover" | "collect";
    status?: string;
    limit: number;
    offset: number;
  },
): RunsResponse {
  return {
    ...envelope(context),
    pagination: {
      limit: options.limit,
      offset: options.offset,
      total: runCount(context.database, options),
    },
    runs: summarizeRuns(context.database, recentRunRows(context.database, options)),
  };
}

export function readRunDetail(
  context: ReadSnapshotContext,
  runId: string,
): RunDetailResponse | null {
  const rows = context.database.prepare(`
    SELECT run.id, run.retailer_id, retailer.name AS retailer_name,
           run.stage, run.collection_day, run.strategy_id, run.strategy_version,
           run.status, run.attempted, run.ok, run.failed, run.started_at,
           run.finished_at, run.metadata_json,
           EXISTS(SELECT 1 FROM runtime_reconciliations reconciliation
                  WHERE reconciliation.kind = 'pipeline-run'
                    AND reconciliation.subject_id = run.id) AS reconciled
    FROM runs run
    JOIN retailers retailer ON retailer.id = run.retailer_id
    WHERE run.id = ?
  `).all(runId) as RunRow[];
  const row = rows[0];
  if (row === undefined) return null;
  const failures = failureGroups(context.database, [runId]).get(runId) ?? [];
  const observations = context.database.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN available = 1 THEN 1 ELSE 0 END), 0) AS available,
           COALESCE(SUM(CASE WHEN promo_price_cents IS NOT NULL THEN 1 ELSE 0 END), 0) AS promotional
    FROM observations
    WHERE run_id = ?
  `).get(runId) as { total: number; available: number; promotional: number };
  const snapshot = context.database.prepare(`
    SELECT complete, completion_reason, discovered, in_scope, out_of_scope, disappeared
    FROM catalog_snapshots WHERE run_id = ?
  `).get(runId) as {
    complete: number;
    completion_reason: string;
    discovered: number;
    in_scope: number;
    out_of_scope: number;
    disappeared: number;
  } | undefined;
  return {
    ...envelope(context),
    run: runSummary(row, failures),
    failureCategories: failures.map((failure) => ({
      category: failure.category,
      responded: failure.responded === 1,
      count: failure.count,
    })),
    observations,
    catalogSnapshot: snapshot === undefined
      ? null
      : {
          complete: snapshot.complete === 1,
          completionReason: snapshot.completion_reason,
          discovered: snapshot.discovered,
          inScope: snapshot.in_scope,
          outOfScope: snapshot.out_of_scope,
          disappeared: snapshot.complete === 1 ? snapshot.disappeared : null,
        },
  };
}

export function readAutomation(context: ReadSnapshotContext): AutomationResponse {
  const classification = classificationFacts(context.database);
  const reservations = context.database.prepare(`
    SELECT id, version, model, status, projected_cost_usd, actual_cost_usd, reserved_at
    FROM classification_sync_reservations
    ORDER BY reserved_at DESC, id DESC
    LIMIT 30
  `).all() as Array<{
    id: string;
    version: number;
    model: string;
    status: string;
    projected_cost_usd: number;
    actual_cost_usd: number | null;
    reserved_at: string;
  }>;
  const jobs = context.database.prepare(`
    SELECT id, version, status, total_items, completed_items, failed_items,
           projected_cost_usd, actual_cost_usd, submitted_at, finalized_at
    FROM classification_batch_jobs
    ORDER BY created_at DESC, id DESC
    LIMIT 30
  `).all() as Array<{
    id: string;
    version: number;
    status: string;
    total_items: number;
    completed_items: number;
    failed_items: number;
    projected_cost_usd: number | null;
    actual_cost_usd: number | null;
    submitted_at: string | null;
    finalized_at: string | null;
  }>;
  const shapeFailures = (context.database.prepare(
    "SELECT COUNT(*) AS count FROM classification_shape_failures",
  ).get() as { count: number }).count;
  const quarantined = (context.database.prepare(`
    SELECT COUNT(*) AS count
    FROM classification_quarantine_events event
    WHERE event.action = 'quarantined'
      AND NOT EXISTS (
        SELECT 1 FROM classification_quarantine_events later
        WHERE later.product_id = event.product_id
          AND later.version = event.version
          AND later.action = 'released'
          AND (later.occurred_at > event.occurred_at
               OR (later.occurred_at = event.occurred_at AND later.id > event.id))
      )
  `).get() as { count: number }).count;
  const healingRows = context.database.prepare(`
    SELECT event.id, event.retailer_id, retailer.name AS retailer_name,
           event.purpose, event.category, event.status, event.attempts,
           event.tier_from, event.tier_to, event.detected_at,
           event.recovered_at, event.duration_seconds
    FROM healing_events event
    JOIN retailers retailer ON retailer.id = event.retailer_id
    ORDER BY event.detected_at DESC, event.id DESC
    LIMIT 50
  `).all() as Array<{
    id: string;
    retailer_id: string;
    retailer_name: string;
    purpose: "discovery" | "extraction";
    category: string;
    status: string;
    attempts: number;
    tier_from: number | null;
    tier_to: number | null;
    detected_at: string;
    recovered_at: string | null;
    duration_seconds: number | null;
  }>;
  const explorations = context.database.prepare(`
    SELECT exploration.id, exploration.retailer_id, retailer.name AS retailer_name,
           exploration.purpose, exploration.trigger, exploration.status,
           exploration.outcome, exploration.events_used, exploration.cost_usd,
           exploration.started_at, exploration.finished_at
    FROM exploration_runs exploration
    JOIN retailers retailer ON retailer.id = exploration.retailer_id
    ORDER BY exploration.started_at DESC, exploration.id DESC
    LIMIT 50
  `).all() as Array<{
    id: string;
    retailer_id: string;
    retailer_name: string;
    purpose: "discovery" | "extraction";
    trigger: string;
    status: string;
    outcome: string | null;
    events_used: number;
    cost_usd: number;
    started_at: string;
    finished_at: string | null;
  }>;

  return {
    ...envelope(context),
    classification: {
      ...classification,
      reservations: reservations.map((row) => ({
        id: row.id,
        version: row.version,
        model: row.model,
        status: row.status,
        projectedCostUsd: row.projected_cost_usd,
        actualCostUsd: row.actual_cost_usd,
        reservedAt: row.reserved_at,
      })),
      batchJobs: jobs.map((row) => ({
        id: row.id,
        version: row.version,
        status: row.status,
        totalItems: row.total_items,
        completedItems: row.completed_items,
        failedItems: row.failed_items,
        projectedCostUsd: row.projected_cost_usd,
        actualCostUsd: row.actual_cost_usd,
        submittedAt: row.submitted_at,
        finalizedAt: row.finalized_at,
      })),
      shapeFailures,
      quarantinedProducts: quarantined,
    },
    strategies: strategySummaries(context.database),
    healingEvents: healingRows.map((row) => ({
      id: row.id,
      retailerId: row.retailer_id,
      retailerName: row.retailer_name,
      purpose: row.purpose,
      category: row.category,
      status: row.status,
      attempts: row.attempts,
      tierFrom: row.tier_from,
      tierTo: row.tier_to,
      detectedAt: row.detected_at,
      recoveredAt: row.recovered_at,
      durationSeconds: row.duration_seconds,
    })),
    explorations: explorations.map((row) => ({
      id: row.id,
      retailerId: row.retailer_id,
      retailerName: row.retailer_name,
      purpose: row.purpose,
      trigger: row.trigger,
      status: row.status,
      outcome: row.outcome,
      eventsUsed: row.events_used,
      costUsd: row.cost_usd,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
  };
}

export function readLimits(
  context: ReadSnapshotContext,
  configuredLimitUsd: number | null,
): LimitsResponse {
  const month = (context.database.prepare(
    "SELECT substr(MAX(occurred_at), 1, 7) AS month FROM cost_ledger",
  ).get() as { month: string | null }).month;
  const totals = context.database.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS spent,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM cost_ledger
    WHERE (? IS NULL OR substr(occurred_at, 1, 7) = ?)
  `).get(month, month) as { spent: number; input_tokens: number; output_tokens: number };
  const reserved = context.database.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) AS reserved
    FROM model_budget_reservations
    WHERE status NOT IN ('settled', 'recovered', 'released', 'failed')
      AND (? IS NULL OR substr(month_start, 1, 7) = ?)
  `).get(month, month) as { reserved: number };
  const categories = context.database.prepare(`
    SELECT category, COUNT(*) AS events, COALESCE(SUM(cost_usd), 0) AS cost,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM cost_ledger
    WHERE (? IS NULL OR substr(occurred_at, 1, 7) = ?)
    GROUP BY category
    ORDER BY cost DESC, category
  `).all(month, month) as Array<{
    category: string;
    events: number;
    cost: number;
    input_tokens: number;
    output_tokens: number;
  }>;
  const retailers = context.database.prepare(`
    SELECT id, name FROM retailers ORDER BY name COLLATE NOCASE, id
  `).all() as Array<{ id: string; name: string }>;
  const admissions = retailers.map((retailer) => {
    const usage = admissionUsage(context.database, retailer.id);
    const network = usage.find(({ kind }) => kind === "network");
    const discovery = usage.find(({ kind }) => kind === "discovery_reference");
    const replay = usage.find(({ kind }) => kind === "replay");
    if (network === undefined || discovery === undefined || replay === undefined) {
      throw new Error("Admission usage is incomplete");
    }
    return {
      retailerId: retailer.id,
      retailerName: retailer.name,
      day: network.day ?? discovery.day ?? replay.day,
      network,
      discoveryReferences: discovery,
      replay,
    };
  });
  const committed = totals.spent + reserved.reserved;
  return {
    ...envelope(context),
    model: {
      month,
      spentUsd: totals.spent,
      reservedUsd: reserved.reserved,
      configuredLimitUsd,
      remainingUsd: configuredLimitUsd === null
        ? null
        : Math.max(0, configuredLimitUsd - committed),
      byCategory: categories.map((row) => ({
        category: row.category,
        events: row.events,
        costUsd: row.cost,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
    },
    admissions,
  };
}

const liveIndexCache = new WeakMap<
  Database.Database,
  { dataVersion: number; series: ReturnType<typeof buildDailyIndex> | null }
>();

function liveIndexSeries(
  context: ReadSnapshotContext,
): ReturnType<typeof buildDailyIndex> | null {
  const cached = liveIndexCache.get(context.database);
  if (cached?.dataVersion === context.dataVersion) return cached.series;
  let series: ReturnType<typeof buildDailyIndex> | null;
  try {
    series = buildDailyIndex(context.database);
  } catch {
    series = null;
  }
  liveIndexCache.set(context.database, { dataVersion: context.dataVersion, series });
  return series;
}

export function readLiveIndex(context: ReadSnapshotContext): IndexResponse {
  const series = liveIndexSeries(context);
  if (series === null) {
    return {
      ...envelope(context),
      status: "no_index_data",
      methodVersion: INDEX_METHOD_VERSION,
      throughDay: null,
      movementPoints: 0,
      aggregate: [],
      coverage: [],
      caveats: indexCaveats(),
    };
  }
  const facts = experimentalDailySeriesFacts(series);
  return {
    ...envelope(context, series.throughDay),
    status: facts.hasExperimentalDailySeries ? "complete" : "no_index_data",
    methodVersion: series.methodVersion,
    throughDay: series.throughDay,
    movementPoints: facts.movementPointCount,
    aggregate: series.aggregate.map((point) => ({
      day: point.day,
      previousDay: point.previousDay,
      chainSegment: point.chainSegment,
      dailyRelative: point.dailyRelative,
      indexLevel: point.indexLevel,
      coverageFraction: point.coverageFraction,
      coveredSubitemCount: point.coveredSubitemCount,
      retailerCount: point.retailerCount,
      productPairCount: point.productPairCount,
    })),
    coverage: series.coverage.map((point) => ({
      day: point.day,
      coverageFraction: point.coverageFraction,
      coveredSubitemCount: point.coveredSubitemCount,
      retailerCount: point.retailerCount,
      productPairCount: point.productPairCount,
      unclassifiedCount: point.unclassifiedCount,
      noHealthyRunCount: point.noHealthyRunCount,
      unavailableCount: point.unavailableCount,
      carriedExpiredCount: point.carriedExpiredCount,
      noDenominatorCount: point.noDenominatorCount,
      invalidPriceCount: point.invalidPriceCount,
    })),
    caveats: indexCaveats(),
  };
}

function indexCaveats(): string[] {
  return [
    "Índice experimental sem validação estatística; não substitui o IPCA oficial.",
    "A série oficial é mensal e nunca é interpolada para frequência diária.",
    "Ausências e quebras de cadeia permanecem lacunas, não valores zero.",
    "Faixas entre varejistas são descritivas e não intervalos de confiança.",
    "A área operacional dos CEPs dos varejistas difere da definição geográfica oficial do SNIPC.",
  ];
}
