import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, parse as parsePath, relative, resolve, sep } from "node:path";

import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";

import { OFFICIAL_IPCA_ARCHIVE_SHA256 } from "../reference/ipca.js";
import {
  buildDailyIndex,
  experimentalDailySeriesFacts,
} from "./aggregate.js";
import { OfficialSidraClient, SIDRA_ENDPOINT } from "./sidra.js";
import {
  INDEX_METHOD_VERSION,
  PUBLISHED_CLASSIFICATION_VERSION,
  TOTAL_FOOD_AT_HOME_WEIGHT,
  type ExportManifest,
  type ExportResearchOptions,
  type ExportedFileEvidence,
  type OfficialMonthlyPoint,
  type SidraFetchResult,
  type SidraSourceEvidence,
} from "./types.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

type CsvValue = string | number | boolean | null | undefined;
type CsvRow = readonly CsvValue[];

interface CsvDefinition {
  name: string;
  columns: string[];
  rows: CsvRow[];
}

function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvBytes(definition: CsvDefinition): Buffer {
  const lines = [definition.columns, ...definition.rows]
    .map((row) => row.map(csvCell).join(","));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function monthFromDay(day: string): string {
  return day.slice(0, 7);
}

function previousMonth(month: string): string {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const value = Number(monthText);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return date.toISOString().slice(0, 7);
}

function saoPauloDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const year = date.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((date.getTime() - start.getTime()) / 86_400_000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function ensureInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))) return;
  throw new Error("Export path escapes output root");
}

export async function assertSafeOutputPath(value: string): Promise<void> {
  const absolute = resolve(value);
  const root = parsePath(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Export output contains a symbolic link component: ${current}`);
      }
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
      ) return;
      throw error;
    }
  }
}

interface ObservationRange {
  first_day: string | null;
  last_day: string | null;
}

const DATABASE_EVIDENCE_TABLES = [
  "retailers", "strategies", "products", "observations", "runs", "run_failures",
  "ipca_items", "classifications", "exploration_runs", "healing_events",
  "retailer_state_events", "cost_ledger",
] as const;

export function databaseSourceSnapshotSha256(database: Database.Database): string {
  const digest = createHash("sha256");
  for (const table of DATABASE_EVIDENCE_TABLES) {
    const columns = database.pragma(`table_info(${table})`) as Array<{
      cid: number;
      name: string;
      pk: number;
    }>;
    if (columns.length === 0) throw new Error(`Database evidence table ${table} is absent`);
    const orderedColumns = [...columns].sort((left, right) => left.cid - right.cid);
    const primaryKey = columns.filter(({ pk }) => pk > 0).sort((left, right) => left.pk - right.pk);
    const order = primaryKey.length === 0 ? orderedColumns : primaryKey;
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const select = orderedColumns.map(({ name }) => quote(name)).join(", ");
    const orderBy = order.map(({ name }) => quote(name)).join(", ");
    digest.update(`${table}\0${orderedColumns.map(({ name }) => name).join("\0")}\n`);
    for (const row of database.prepare(
      `SELECT ${select} FROM ${quote(table)} ORDER BY ${orderBy}`,
    ).iterate() as Iterable<Record<string, unknown>>) {
      digest.update(JSON.stringify(orderedColumns.map(({ name }) => row[name])));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}

function observationRange(database: Database.Database): ObservationRange {
  return database.prepare(
    "SELECT MIN(collection_day) AS first_day, MAX(collection_day) AS last_day FROM observations",
  ).get() as ObservationRange;
}

function databaseEvidence(database: Database.Database): ExportManifest["sources"]["database"] {
  const counts: Record<string, number> = {};
  for (const table of DATABASE_EVIDENCE_TABLES) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    counts[table] = row.count;
  }
  const maximaRow = database.prepare(`
    SELECT
      (SELECT MAX(observed_at) FROM observations) AS observations,
      (SELECT MAX(finished_at) FROM runs) AS runs,
      (SELECT MAX(created_at) FROM classifications) AS classifications,
      (SELECT MAX(COALESCE(recovered_at, detected_at)) FROM healing_events) AS healing_events,
      (SELECT MAX(effective_at) FROM retailer_state_events) AS retailer_state_events,
      (SELECT MAX(occurred_at) FROM cost_ledger) AS cost_ledger
  `).get() as Record<string, string | null>;
  return {
    counts,
    maxima: maximaRow,
    snapshotSha256: databaseSourceSnapshotSha256(database),
  };
}

function ipcaEvidence(database: Database.Database): ExportManifest["sources"]["ipcaWeights"] {
  const rows = database.prepare(`
    SELECT id, code, weight_text, source_archive_sha256
    FROM ipca_items WHERE in_scope = 1
    ORDER BY code, id
  `).all() as Array<{
    id: string;
    code: string;
    weight_text: string | null;
    source_archive_sha256: string | null;
  }>;
  if (rows.length !== 84) {
    throw new Error(`IPCA weight contract requires exactly 84 in-scope rows; received ${rows.length}`);
  }
  if (new Set(rows.map((row) => row.id)).size !== 84 || new Set(rows.map((row) => row.code)).size !== 84) {
    throw new Error("IPCA weight contract requires 84 unique rows and subitem codes");
  }
  let total = new D(0);
  const provenance = new Set<string>();
  for (const row of rows) {
    if (row.weight_text === null || !/^(?:0|[1-9]\d*)\.\d{4}$/u.test(row.weight_text)) {
      throw new Error(`IPCA weight ${row.code} must have exactly four decimal places`);
    }
    total = total.plus(row.weight_text);
    if (
      row.source_archive_sha256 === null
      || !/^[0-9a-f]{64}$/u.test(row.source_archive_sha256)
    ) {
      throw new Error(`IPCA weight ${row.code} lacks a verified provenance hash`);
    }
    provenance.add(row.source_archive_sha256);
  }
  if (!total.eq(TOTAL_FOOD_AT_HOME_WEIGHT)) {
    throw new Error(
      `IPCA weight contract totals ${total.toFixed(4)}, expected ${TOTAL_FOOD_AT_HOME_WEIGHT}`,
    );
  }
  if (provenance.size !== 1) {
    throw new Error("IPCA weights must share one verified provenance hash");
  }
  const archiveSha256 = provenance.values().next().value;
  if (archiveSha256 === undefined) throw new Error("IPCA provenance hash is absent");
  if (archiveSha256 !== OFFICIAL_IPCA_ARCHIVE_SHA256) {
    throw new Error("IPCA weights do not match the approved IBGE archive provenance");
  }
  return {
    rows: 84,
    totalWeight: TOTAL_FOOD_AT_HOME_WEIGHT,
    archiveSha256,
  };
}

export class OfficialSourceUnavailableError extends Error {
  override readonly name = "OfficialSourceUnavailableError";
  readonly manifest: ExportManifest;

  constructor(manifest: ExportManifest, sourceMessage: string | undefined) {
    super(sourceMessage === undefined
      ? "Official SIDRA comparison is unavailable; an honest snapshot was published"
      : `Official SIDRA comparison is unavailable; an honest snapshot was published: ${sourceMessage}`);
    this.manifest = manifest;
  }
}

function localMonthlyComparison(
  aggregate: ReturnType<typeof buildDailyIndex>["aggregate"],
  official: readonly OfficialMonthlyPoint[],
  currentMonth: string,
): CsvRow[] {
  const monthEnds = new Map<string, (typeof aggregate)[number]>();
  for (const point of aggregate) {
    if (point.indexLevel === null) continue;
    const month = monthFromDay(point.day);
    if (month >= currentMonth) continue;
    const previous = monthEnds.get(month);
    if (previous === undefined || previous.day < point.day) monthEnds.set(month, point);
  }
  const local = new Map<string, { variation: string; segment: number }>();
  for (const [month, current] of monthEnds) {
    const prior = monthEnds.get(previousMonth(month));
    if (
      prior === undefined || prior.indexLevel === null || current.indexLevel === null
      || prior.chainSegment !== current.chainSegment
    ) continue;
    local.set(month, {
      variation: new D(current.indexLevel).div(prior.indexLevel).minus(1).mul(100).toFixed(6),
      segment: current.chainSegment,
    });
  }
  const officialByMonth = new Map(official.map((point) => [point.month, point]));
  const months = [...new Set([...local.keys(), ...officialByMonth.keys()])].sort();
  return months.map((month): CsvRow => {
    const experimental = local.get(month);
    const source = officialByMonth.get(month);
    const status = experimental !== undefined && source !== undefined
      ? "overlap"
      : experimental !== undefined ? "official_missing" : "experimental_missing";
    return [month, experimental?.variation, source?.variationPct, status, experimental?.segment];
  });
}

function operationalCsv(database: Database.Database): CsvDefinition[] {
  const runs = database.prepare(`
    SELECT r.id, r.retailer_id, retailer.name AS retailer_name,
           r.collection_day, r.stage, r.status, r.attempted, r.ok, r.failed,
           CASE WHEN r.attempted = 0 THEN NULL
                ELSE CAST(r.ok AS REAL) / r.attempted END AS success_rate,
           r.strategy_id, r.strategy_version, r.started_at, r.finished_at,
           r.error_category
    FROM runs r LEFT JOIN retailers retailer ON retailer.id = r.retailer_id
    ORDER BY r.collection_day, r.started_at, r.id
  `).all() as Array<Record<string, CsvValue>>;
  const failures = database.prepare(`
    SELECT r.collection_day, f.retailer_id, retailer.name AS retailer_name,
           f.run_id, f.category, COUNT(*) AS count
    FROM run_failures f
    JOIN runs r ON r.id = f.run_id
    LEFT JOIN retailers retailer ON retailer.id = f.retailer_id
    GROUP BY r.collection_day, f.retailer_id, retailer.name, f.run_id, f.category
    ORDER BY r.collection_day, f.retailer_id, f.run_id, f.category
  `).all() as Array<Record<string, CsvValue>>;
  const healing = database.prepare(`
    SELECT h.id, h.retailer_id, retailer.name AS retailer_name, h.purpose,
           h.status, h.onset_run_id, h.previous_strategy_id,
           h.successor_strategy_id, h.attempts, h.tier_from, h.tier_to,
           h.drift_started_at, h.detected_at, h.recovered_at, h.duration_seconds
    FROM healing_events h JOIN retailers retailer ON retailer.id = h.retailer_id
    ORDER BY h.detected_at, h.id
  `).all() as Array<Record<string, CsvValue>>;
  const costs = database.prepare(`
    SELECT substr(occurred_at, 1, 7) AS month, retailer_id, category, provider,
           COALESCE(model, '') AS model, SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           printf('%.8f', SUM(cost_usd)) AS cost_usd, COUNT(*) AS event_count
    FROM cost_ledger
    GROUP BY substr(occurred_at, 1, 7), retailer_id, category, provider, COALESCE(model, '')
    ORDER BY month, retailer_id, category, provider, model
  `).all() as Array<Record<string, CsvValue>>;
  const classifications = database.prepare(`
    WITH latest AS (
      SELECT c.*, ROW_NUMBER() OVER (
        PARTITION BY c.product_id ORDER BY c.version DESC, c.created_at DESC, c.id DESC
      ) AS position
      FROM classifications c
    )
    SELECT p.retailer_id, retailer.name AS retailer_name,
           COUNT(*) AS total_in_scope_products,
           SUM(CASE WHEN latest.ipca_item_id IS NOT NULL THEN 1 ELSE 0 END) AS classified_products,
           SUM(CASE WHEN latest.ipca_item_id IS NULL THEN 1 ELSE 0 END) AS unclassified_products,
           CASE WHEN COUNT(*) = 0 THEN NULL
                ELSE CAST(SUM(CASE WHEN latest.ipca_item_id IS NOT NULL THEN 1 ELSE 0 END) AS REAL) / COUNT(*) END AS classification_rate,
           MAX(latest.version) AS latest_version
    FROM products p
    JOIN retailers retailer ON retailer.id = p.retailer_id
    LEFT JOIN latest ON latest.product_id = p.id AND latest.position = 1
    WHERE p.in_scope = 1
    GROUP BY p.retailer_id, retailer.name
    ORDER BY p.retailer_id
  `).all() as Array<Record<string, CsvValue>>;

  return [
    {
      name: "runs.csv",
      columns: ["run_id", "retailer_id", "retailer_name", "collection_day", "stage", "status", "attempted", "ok", "failed", "success_rate", "strategy_id", "strategy_version", "started_at", "finished_at", "error_category"],
      rows: runs.map((row) => [row.id, row.retailer_id, row.retailer_name, row.collection_day, row.stage, row.status, row.attempted, row.ok, row.failed, row.success_rate, row.strategy_id, row.strategy_version, row.started_at, row.finished_at, row.error_category]),
    },
    {
      name: "failures.csv",
      columns: ["collection_day", "retailer_id", "retailer_name", "run_id", "category", "count"],
      rows: failures.map((row) => [row.collection_day, row.retailer_id, row.retailer_name, row.run_id, row.category, row.count]),
    },
    {
      name: "healing_events.csv",
      columns: ["event_id", "retailer_id", "retailer_name", "purpose", "status", "onset_run_id", "previous_strategy_id", "successor_strategy_id", "attempts", "tier_from", "tier_to", "drift_started_at", "detected_at", "recovered_at", "duration_seconds"],
      rows: healing.map((row) => [row.id, row.retailer_id, row.retailer_name, row.purpose, row.status, row.onset_run_id, row.previous_strategy_id, row.successor_strategy_id, row.attempts, row.tier_from, row.tier_to, row.drift_started_at, row.detected_at, row.recovered_at, row.duration_seconds]),
    },
    {
      name: "model_costs.csv",
      columns: ["month", "retailer_id", "category", "provider", "model", "input_tokens", "output_tokens", "cost_usd", "event_count"],
      rows: costs.map((row) => [row.month, row.retailer_id, row.category, row.provider, row.model, row.input_tokens, row.output_tokens, row.cost_usd, row.event_count]),
    },
    {
      name: "classification_coverage.csv",
      columns: ["retailer_id", "retailer_name", "total_in_scope_products", "classified_products", "unclassified_products", "classification_rate", "latest_version"],
      rows: classifications.map((row) => [row.retailer_id, row.retailer_name, row.total_in_scope_products, row.classified_products, row.unclassified_products, row.classification_rate, row.latest_version]),
    },
  ];
}

function indexCsv(
  series: ReturnType<typeof buildDailyIndex>,
  sidra: SidraFetchResult | null,
  currentMonth: string,
): CsvDefinition[] {
  return [
    {
      name: "product_relatives.csv",
      columns: ["date", "previous_date", "retailer_id", "product_id", "ipca_item_id", "ipca_code", "classification_id", "classification_version", "numerator_cents", "denominator_cents", "numerator_source_date", "denominator_source_date", "numerator_carried", "denominator_carried", "numerator_carry_reason", "denominator_carry_reason", "relative"],
      rows: series.productRelatives.map((point) => [point.day, point.previousDay, point.retailerId, point.productId, point.ipcaItemId, point.ipcaCode, point.classificationId, point.classificationVersion, point.numeratorCents, point.denominatorCents, point.numeratorSourceDay, point.denominatorSourceDay, point.numeratorCarried, point.denominatorCarried, point.numeratorCarryReason, point.denominatorCarryReason, point.relative]),
    },
    {
      name: "retailer_subitem_daily.csv",
      columns: ["date", "previous_date", "retailer_id", "retailer_name", "ipca_item_id", "ipca_code", "relative", "product_pair_count"],
      rows: series.retailerSubitems.map((point) => [point.day, point.previousDay, point.retailerId, point.retailerName, point.ipcaItemId, point.ipcaCode, point.relative, point.productPairCount]),
    },
    {
      name: "subitem_daily.csv",
      columns: ["date", "previous_date", "ipca_item_id", "ipca_code", "ipca_name", "weight_pct_total_ipca", "relative", "retailer_count", "product_pair_count", "retailer_min_relative", "retailer_max_relative"],
      rows: series.subitems.map((point) => [point.day, point.previousDay, point.ipcaItemId, point.ipcaCode, point.ipcaName, point.weightText, point.relative, point.retailerCount, point.productPairCount, point.retailerMinRelative, point.retailerMaxRelative]),
    },
    {
      name: "aggregate_daily.csv",
      columns: ["date", "previous_date", "chain_segment", "daily_relative", "index_level", "covered_weight_pct_total_ipca", "total_food_at_home_weight_pct_total_ipca", "coverage_fraction", "covered_subitem_count", "retailer_count", "product_pair_count", "descriptive_low_relative", "descriptive_high_relative", "method_version"],
      rows: series.aggregate.map((point) => [point.day, point.previousDay, point.chainSegment, point.dailyRelative, point.indexLevel, point.coveredWeightText, point.totalFoodAtHomeWeightText, point.coverageFraction, point.coveredSubitemCount, point.retailerCount, point.productPairCount, point.descriptiveLowRelative, point.descriptiveHighRelative, INDEX_METHOD_VERSION]),
    },
    {
      name: "coverage_daily.csv",
      columns: ["date", "covered_weight_pct_total_ipca", "total_food_at_home_weight_pct_total_ipca", "coverage_fraction", "covered_subitem_count", "retailer_count", "product_pair_count", "unclassified_count", "no_healthy_run_count", "unavailable_count", "carried_expired_count", "no_denominator_count", "invalid_price_count"],
      rows: series.coverage.map((point) => [point.day, point.coveredWeightText, point.totalFoodAtHomeWeightText, point.coverageFraction, point.coveredSubitemCount, point.retailerCount, point.productPairCount, point.unclassifiedCount, point.noHealthyRunCount, point.unavailableCount, point.carriedExpiredCount, point.noDenominatorCount, point.invalidPriceCount]),
    },
    {
      name: "official_ipca_monthly.csv",
      columns: ["month", "variation_pct", "variable_id", "territorial_level", "area_code", "area_name", "classification_id", "category_id", "source_url", "source_response_sha256"],
      rows: (sidra?.points ?? []).map((point) => [point.month, point.variationPct, point.variableId, point.territorialLevel, point.areaCode, point.areaName, point.classificationId, point.categoryId, sidra?.endpoint, sidra?.responseSha256]),
    },
    {
      name: "monthly_comparison.csv",
      columns: ["month", "experimental_variation_pct", "official_variation_pct", "status", "experimental_chain_segment"],
      rows: localMonthlyComparison(series.aggregate, sidra?.points ?? [], currentMonth),
    },
  ];
}

async function atomicLatest(outputRoot: string, value: unknown): Promise<void> {
  const temporary = join(outputRoot, `.latest-${randomUUID()}.tmp`);
  const destination = join(outputRoot, "latest.json");
  ensureInside(outputRoot, temporary);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

export async function exportResearchData(
  database: Database.Database,
  options: ExportResearchOptions,
): Promise<ExportManifest> {
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Export clock returned an invalid date");
  const outputRoot = resolve(options.outputRoot);
  const snapshotsRoot = join(outputRoot, "snapshots");
  ensureInside(outputRoot, snapshotsRoot);
  await assertSafeOutputPath(outputRoot);
  await assertSafeOutputPath(snapshotsRoot);
  const currentMonth = monthFromDay(saoPauloDay(now));
  const classificationVersion = options.classificationVersion
    ?? PUBLISHED_CLASSIFICATION_VERSION;
  const databaseSnapshot = database.transaction(() => {
    const range = observationRange(database);
    const series = buildDailyIndex(database, {
      cutoffAt: now.toISOString(),
      ...(options.throughDay === undefined ? {} : { throughDay: options.throughDay }),
      classificationVersion,
    });
    return {
      range,
      series,
      operational: operationalCsv(database),
      ipca: ipcaEvidence(database),
      database: databaseEvidence(database),
    };
  }).deferred();
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await assertSafeOutputPath(outputRoot);
  if (await realpath(outputRoot) !== outputRoot) {
    throw new Error("Export output real path differs from its validated path");
  }
  const range = databaseSnapshot.range;
  const startMonth = range.first_day === null ? currentMonth : monthFromDay(range.first_day);
  const endMonth = range.last_day === null ? currentMonth : monthFromDay(range.last_day);
  const sidraClient = options.sidraClient ?? new OfficialSidraClient();
  let sidra: SidraFetchResult | null = null;
  let sidraError: string | undefined;
  try {
    sidra = await sidraClient.fetchSeries(startMonth, endMonth);
  } catch (error) {
    sidraError = error instanceof Error ? error.message : String(error);
    await options.alertSink?.send({
      severity: "warning",
      title: "Official SIDRA comparison unavailable",
      message: "The local index snapshot will be published without official comparison values",
      details: { startMonth, endMonth, error: sidraError },
    });
  }

  const series = databaseSnapshot.series;
  const definitions = [
    ...indexCsv(series, sidra, currentMonth),
    ...databaseSnapshot.operational,
  ].sort((left, right) => left.name.localeCompare(right.name));
  const encoded = definitions.map((definition) => ({ definition, bytes: csvBytes(definition) }));
  const digest = sha256(Buffer.concat(encoded.map(({ bytes }) => bytes))).slice(0, 12);
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const snapshotId = `${isoWeek(saoPauloDay(now))}-${stamp}-${digest}`;
  if (!/^[0-9]{4}-W[0-9]{2}-[0-9TZ-]+-[0-9a-f]{12}$/u.test(snapshotId)) {
    throw new Error("Generated an unsafe snapshot ID");
  }
  const snapshotDirectory = `snapshots/${snapshotId}`;
  const finalDirectory = join(outputRoot, snapshotDirectory);
  const temporaryDirectory = join(outputRoot, `.snapshot-${randomUUID()}.tmp`);
  ensureInside(outputRoot, finalDirectory);
  ensureInside(outputRoot, temporaryDirectory);
  await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
  await assertSafeOutputPath(snapshotsRoot);
  if (await realpath(snapshotsRoot) !== snapshotsRoot) {
    throw new Error("Export snapshots real path differs from its validated path");
  }
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    const files: ExportedFileEvidence[] = [];
    for (const { definition, bytes } of encoded) {
      const path = join(temporaryDirectory, definition.name);
      await writeFile(path, bytes, { mode: 0o600 });
      files.push({
        path: definition.name,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        rows: definition.rows.length,
        columns: definition.columns,
      });
    }
    const sourceEvidence: SidraSourceEvidence = sidra === null
      ? {
          status: "unavailable",
          endpoint: SIDRA_ENDPOINT,
          responseSha256: null,
          fetchedRange: { startMonth, endMonth },
          missingMonths: [],
          ...(sidraError === undefined ? {} : { error: sidraError }),
        }
      : {
          status: sidra.status,
          endpoint: sidra.endpoint,
          responseSha256: sidra.responseSha256,
          fetchedRange: { startMonth, endMonth },
          missingMonths: sidra.missingMonths,
        };
    const { hasExperimentalDailySeries } = experimentalDailySeriesFacts(series);
    const status = sidra === null
      ? "official_unavailable" as const
      : !hasExperimentalDailySeries ? "no_index_data" as const : "complete" as const;
    const manifest: ExportManifest = {
      schemaVersion: 1,
      snapshotId,
      generatedAt: now.toISOString(),
      timezone: "America/Sao_Paulo",
      methodVersion: INDEX_METHOD_VERSION,
      status,
      snapshotDirectory,
      files,
      sources: {
        ipcaWeights: databaseSnapshot.ipca,
        sidra: sourceEvidence,
        database: databaseSnapshot.database,
      },
      parameters: {
        classificationPolicy: "single_version",
        classificationVersion,
        promoPreferred: true,
        carryForwardDays: 7,
        withinRetailer: "jevons",
        acrossRetailers: "arithmetic_equal",
        acrossSubitems: "covered_weight_laspeyres_chain",
      },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(temporaryDirectory, "manifest.json"), manifestBytes, { mode: 0o600 });
    await rename(temporaryDirectory, finalDirectory);
    await atomicLatest(outputRoot, {
      schemaVersion: 1,
      snapshotId,
      snapshotDirectory,
      manifestSha256: sha256(manifestBytes),
    });
    if (sidra === null && options.requireOfficial === true) {
      throw new OfficialSourceUnavailableError(manifest, sidraError);
    }
    return manifest;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyExportManifest(
  outputRoot: string,
  manifest: ExportManifest,
): Promise<void> {
  const root = resolve(outputRoot);
  const snapshot = join(root, manifest.snapshotDirectory);
  ensureInside(root, snapshot);
  if (basename(snapshot) !== manifest.snapshotId) throw new Error("Snapshot manifest path mismatch");
  for (const file of manifest.files) {
    const path = join(snapshot, file.path);
    ensureInside(snapshot, path);
    const bytes = await readFile(path);
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`Snapshot file failed verification: ${file.path}`);
    }
  }
}
