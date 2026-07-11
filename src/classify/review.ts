import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { z } from "zod";

const SHA256 = /^[a-f0-9]{64}$/u;
const IPCA_CODE = /^\d{7}$/u;
const REVIEW_SENTINELS = new Set(["unclassified", "out_of_scope"]);

export const CLASSIFICATION_REVIEW_SIZE = 200;

export const CLASSIFICATION_REVIEW_HEADERS = [
  "schema_version",
  "classification_version",
  "sampled_at",
  "population_size",
  "sampling_frame_sha256",
  "sample_sha256",
  "sample_index",
  "stratum",
  "classification_id",
  "product_id",
  "retailer_id",
  "title",
  "brand",
  "source_category",
  "predicted_label",
  "confidence",
  "reviewed_label",
] as const;

type ReviewHeader = (typeof CLASSIFICATION_REVIEW_HEADERS)[number];
type CsvRow = Record<ReviewHeader, string>;

interface ClassificationFrameRow {
  classification_id: string;
  product_id: string;
  retailer_id: string;
  ipca_item_id: string | null;
  ipca_code: string | null;
  confidence: number;
  version: number;
  created_at: string;
  input_json: string;
}

interface ReviewCoreRow {
  classificationId: string;
  productId: string;
  retailerId: string;
  title: string;
  brand: string | null;
  sourceCategory: string | null;
  predictedLabel: string;
  confidence: number;
  stratum: string;
}

export interface ClassificationReviewTemplate {
  schemaVersion: 1;
  classificationVersion: number;
  sampledAt: string;
  populationSize: number;
  sampleSize: number;
  samplingFrameSha256: string;
  sampleSha256: string;
  templateSha256: string;
  rows: ReviewCoreRow[];
  csv: string;
}

const MetricSchema = z.object({
  reviewed: z.number().int().nonnegative(),
  assigned: z.number().int().nonnegative(),
  correctAssigned: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1).nullable(),
  agreementCorrect: z.number().int().nonnegative(),
  agreementRate: z.number().min(0).max(1),
  outOfScope: z.number().int().nonnegative(),
}).strict();

const StratumMetricSchema = MetricSchema.extend({
  stratum: z.string().min(1).max(500),
}).strict();

const ReviewResultRowSchema = z.object({
  classificationRefSha256: z.string().regex(SHA256),
  stratum: z.string().min(1).max(500),
  predictedLabel: z.string().min(1).max(100),
  reviewedLabel: z.string().min(1).max(100),
  correct: z.boolean(),
}).strict();

export const ClassificationReviewResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("complete"),
  classificationVersion: z.number().int().positive(),
  sampledAt: z.string().datetime(),
  reviewedAt: z.string().datetime(),
  reviewerRefSha256: z.string().regex(SHA256),
  populationSize: z.number().int().positive(),
  sampleSize: z.number().int().positive(),
  samplingFrameSha256: z.string().regex(SHA256),
  sampleSha256: z.string().regex(SHA256),
  templateSha256: z.string().regex(SHA256),
  reviewedLabelsSha256: z.string().regex(SHA256),
  overall: MetricSchema,
  strata: z.array(StratumMetricSchema).min(1),
  reviews: z.array(ReviewResultRowSchema).min(1),
}).strict();

export type ClassificationReviewResult = z.infer<
  typeof ClassificationReviewResultSchema
>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(name: string, value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function publicText(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw new TypeError("Classification review text must be a string or null");
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized === "") {
    if (nullable) return null;
    throw new TypeError("Classification review title must not be empty");
  }
  if (normalized.length > 500 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("Classification review text is not public-safe");
  }
  return normalized;
}

function originalProductText(inputJson: string): {
  title: string;
  brand: string | null;
  sourceCategory: string | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(inputJson);
  } catch {
    throw new TypeError("Classification input evidence is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Classification input evidence is not an object");
  }
  const input = value as Record<string, unknown>;
  return {
    title: publicText(input.title, false) as string,
    brand: publicText(input.brand ?? null, true),
    sourceCategory: publicText(input.sourceCategory ?? null, true),
  };
}

function validateConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("Classification confidence is invalid");
  }
}

function confidenceBand(confidence: number): "below-0.80" | "0.80-to-0.89" | "0.90-plus" {
  if (confidence < 0.8) return "below-0.80";
  if (confidence < 0.9) return "0.80-to-0.89";
  return "0.90-plus";
}

function reviewStratum(row: {
  retailerId: string;
  predictedLabel: string;
  confidence: number;
}): string {
  const decision = row.predictedLabel === "unclassified" ? "abstained" : "assigned";
  return `retailer:${row.retailerId}|decision:${decision}|confidence:${confidenceBand(row.confidence)}`;
}

function frame(
  database: Database.Database,
  version: number,
  sampledAt: string,
): ReviewCoreRow[] {
  const rows = database.prepare(`
    SELECT classification.id AS classification_id,
      classification.product_id,
      product.retailer_id,
      classification.ipca_item_id,
      item.code AS ipca_code,
      classification.confidence,
      classification.version,
      classification.created_at,
      classification.input_json
    FROM classifications AS classification
    JOIN products AS product ON product.id = classification.product_id
    LEFT JOIN ipca_items AS item ON item.id = classification.ipca_item_id
    WHERE classification.version = ?
      AND classification.created_at <= ?
    ORDER BY classification.id
  `).all(version, sampledAt) as ClassificationFrameRow[];
  return rows.map((row) => {
    if (row.version !== version || !Number.isFinite(Date.parse(row.created_at))
      || Date.parse(row.created_at) > Date.parse(sampledAt)) {
      throw new TypeError("Classification frame contains invalid version or time evidence");
    }
    const predictedLabel = row.ipca_item_id === null ? "unclassified" : row.ipca_code;
    if (predictedLabel === null || (predictedLabel !== "unclassified" && !IPCA_CODE.test(predictedLabel))) {
      throw new TypeError("Classification frame contains an invalid predicted item");
    }
    const text = originalProductText(row.input_json);
    validateConfidence(row.confidence);
    const core = {
      classificationId: row.classification_id,
      productId: row.product_id,
      retailerId: row.retailer_id,
      ...text,
      predictedLabel,
      confidence: row.confidence,
    };
    return { ...core, stratum: reviewStratum(core) };
  });
}

function stableFrameHash(rows: readonly ReviewCoreRow[]): string {
  return sha256(JSON.stringify([...rows]
    .sort((left, right) => left.classificationId.localeCompare(right.classificationId, "en"))
    .map((row) => ({
      classificationId: row.classificationId,
      productId: row.productId,
      retailerId: row.retailerId,
      predictedLabel: row.predictedLabel,
      confidence: row.confidence,
      stratum: row.stratum,
    }))));
}

function selectStratified(
  rows: readonly ReviewCoreRow[],
  size: number,
  version: number,
  samplingFrameSha256: string,
): ReviewCoreRow[] {
  const rank = (left: ReviewCoreRow, right: ReviewCoreRow): number => {
    const leftHash = sha256(`classification-review-v1\0${version}\0${samplingFrameSha256}\0${left.classificationId}`);
    const rightHash = sha256(`classification-review-v1\0${version}\0${samplingFrameSha256}\0${right.classificationId}`);
    return leftHash.localeCompare(rightHash, "en");
  };
  const balancePredictedLabels = (values: ReviewCoreRow[]): ReviewCoreRow[] => {
    const labels = new Map<string, ReviewCoreRow[]>();
    for (const row of values) {
      const rows = labels.get(row.predictedLabel) ?? [];
      rows.push(row);
      labels.set(row.predictedLabel, rows);
    }
    const rankedLabels = [...labels.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([, rows]) => rows.sort(rank));
    const balanced: ReviewCoreRow[] = [];
    for (let index = 0; ; index += 1) {
      let added = false;
      for (const rows of rankedLabels) {
        const row = rows[index];
        if (row !== undefined) {
          balanced.push(row);
          added = true;
        }
      }
      if (!added) return balanced;
    }
  };
  const strata = new Map<string, ReviewCoreRow[]>();
  for (const row of rows) {
    const values = strata.get(row.stratum) ?? [];
    values.push(row);
    strata.set(row.stratum, values);
  }
  const ranked = [...strata.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    // Predicted-label round-robin is secondary to the declared retailer ×
    // decision × confidence stratum, preventing dominant sub-items from
    // consuming a stratum before rarer assigned labels are represented.
    .map(([, values]) => balancePredictedLabels(values));
  const selected: ReviewCoreRow[] = [];
  for (let index = 0; selected.length < size; index += 1) {
    let added = false;
    for (const group of ranked) {
      const row = group[index];
      if (row !== undefined && selected.length < size) {
        selected.push(row);
        added = true;
      }
    }
    if (!added) break;
  }
  return selected;
}

function sampleHash(rows: readonly ReviewCoreRow[]): string {
  return sha256(JSON.stringify(rows.map((row) => ({
    classificationId: row.classificationId,
    productId: row.productId,
    retailerId: row.retailerId,
    title: row.title,
    brand: row.brand,
    sourceCategory: row.sourceCategory,
    predictedLabel: row.predictedLabel,
    confidence: row.confidence,
    stratum: row.stratum,
  }))));
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function spreadsheetSafe(value: string | null): string {
  if (value === null) return "";
  return /^[=+\-@]/u.test(value) ? `'${value}` : value;
}

function serializeCsv(rows: readonly CsvRow[]): string {
  const lines = [CLASSIFICATION_REVIEW_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(CLASSIFICATION_REVIEW_HEADERS.map((header) => csvCell(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvRows(template: Omit<ClassificationReviewTemplate, "rows" | "csv" | "templateSha256">, rows: readonly ReviewCoreRow[]): CsvRow[] {
  return rows.map((row, index) => ({
    schema_version: "1",
    classification_version: String(template.classificationVersion),
    sampled_at: template.sampledAt,
    population_size: String(template.populationSize),
    sampling_frame_sha256: template.samplingFrameSha256,
    sample_sha256: template.sampleSha256,
    sample_index: String(index + 1),
    stratum: row.stratum,
    classification_id: row.classificationId,
    product_id: row.productId,
    retailer_id: row.retailerId,
    title: spreadsheetSafe(row.title),
    brand: spreadsheetSafe(row.brand),
    source_category: spreadsheetSafe(row.sourceCategory),
    predicted_label: row.predictedLabel,
    confidence: String(row.confidence),
    reviewed_label: "",
  }));
}

export function buildClassificationReviewTemplate(
  database: Database.Database,
  options: { version: number; sampledAt: string; size?: number },
): ClassificationReviewTemplate {
  const classificationVersion = positiveInteger("classification review version", options.version, 1_000_000);
  const sampledAt = canonicalTimestamp("sampledAt", options.sampledAt);
  const size = positiveInteger("classification review size", options.size ?? CLASSIFICATION_REVIEW_SIZE, 1_000);
  const population = frame(database, classificationVersion, sampledAt);
  if (population.length < size) {
    throw new Error(`Classification review requires ${size} rows; only ${population.length} are available`);
  }
  const samplingFrameSha256 = stableFrameHash(population);
  const selected = selectStratified(population, size, classificationVersion, samplingFrameSha256);
  if (selected.length !== size) throw new Error("Classification review sampling did not reach its target");
  const selectedSha256 = sampleHash(selected);
  const metadata = {
    schemaVersion: 1 as const,
    classificationVersion,
    sampledAt,
    populationSize: population.length,
    sampleSize: selected.length,
    samplingFrameSha256,
    sampleSha256: selectedSha256,
  };
  const csv = serializeCsv(csvRows(metadata, selected));
  return {
    ...metadata,
    templateSha256: sha256(csv),
    rows: selected,
    csv,
  };
}

function parseReviewedCsv(value: string | Uint8Array): CsvRow[] {
  let records: string[][];
  try {
    records = parse(value, {
      columns: false,
      bom: false,
      skip_empty_lines: true,
      relax_column_count: false,
    }) as string[][];
  } catch {
    throw new TypeError("Reviewed classification CSV is malformed");
  }
  const [headers, ...rows] = records;
  if (headers === undefined
    || headers.join("\0") !== CLASSIFICATION_REVIEW_HEADERS.join("\0")) {
    throw new TypeError("Reviewed classification CSV headers are not exact");
  }
  return rows.map((values) => Object.fromEntries(
    CLASSIFICATION_REVIEW_HEADERS.map((header, index) => [header, values[index] ?? ""]),
  ) as CsvRow);
}

function allowedReviewLabels(database: Database.Database): Set<string> {
  const codes = database.prepare(`
    SELECT code FROM ipca_items
    WHERE in_scope = 1 AND item_group = 'alimentacao_no_domicilio'
    ORDER BY code
  `).all() as Array<{ code: string }>;
  return new Set([...REVIEW_SENTINELS, ...codes.map((row) => row.code)]);
}

function metric(rows: readonly z.infer<typeof ReviewResultRowSchema>[]): z.infer<typeof MetricSchema> {
  const assignedRows = rows.filter((row) => IPCA_CODE.test(row.predictedLabel));
  const correctAssigned = assignedRows.filter((row) => row.correct).length;
  const agreementCorrect = rows.filter((row) => row.correct).length;
  return {
    reviewed: rows.length,
    assigned: assignedRows.length,
    correctAssigned,
    precision: assignedRows.length === 0 ? null : correctAssigned / assignedRows.length,
    agreementCorrect,
    agreementRate: rows.length === 0 ? 0 : agreementCorrect / rows.length,
    outOfScope: rows.filter((row) => row.reviewedLabel === "out_of_scope").length,
  };
}

function metricsByStratum(rows: readonly z.infer<typeof ReviewResultRowSchema>[]): Array<z.infer<typeof StratumMetricSchema>> {
  const strata = new Map<string, z.infer<typeof ReviewResultRowSchema>[]>();
  for (const row of rows) {
    const values = strata.get(row.stratum) ?? [];
    values.push(row);
    strata.set(row.stratum, values);
  }
  return [...strata.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([stratum, values]) => ({ stratum, ...metric(values) }));
}

function same(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey, "en"))
      .map(([key, item]) => [key, canonical(item)]));
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function evaluateClassificationReview(
  database: Database.Database,
  reviewedCsv: string | Uint8Array,
  options: {
    reviewerId: string;
    reviewedAt: string;
    now?: Date;
  },
): ClassificationReviewResult {
  const rows = parseReviewedCsv(reviewedCsv);
  if (rows.length === 0) throw new TypeError("Reviewed classification CSV is empty");
  const first = rows[0]!;
  const version = Number(first.classification_version);
  const size = rows.length;
  const sampledAt = canonicalTimestamp("sampledAt", first.sampled_at);
  const template = buildClassificationReviewTemplate(database, { version, sampledAt, size });
  const expectedRows = csvRows(template, template.rows);
  const labels = allowedReviewLabels(database);
  const seenClassifications = new Set<string>();
  const reviews: Array<z.infer<typeof ReviewResultRowSchema>> = [];
  rows.forEach((row, index) => {
    const expected = expectedRows[index];
    if (expected === undefined) throw new TypeError("Reviewed classification CSV has unexpected rows");
    for (const header of CLASSIFICATION_REVIEW_HEADERS) {
      if (header !== "reviewed_label" && row[header] !== expected[header]) {
        throw new TypeError(`Reviewed classification CSV changed bound field ${header}`);
      }
    }
    if (seenClassifications.has(row.classification_id)) {
      throw new TypeError("Reviewed classification CSV contains duplicate classifications");
    }
    seenClassifications.add(row.classification_id);
    if (!labels.has(row.reviewed_label)) {
      throw new TypeError("Reviewed classification CSV contains an unknown or empty label");
    }
    reviews.push({
      classificationRefSha256: sha256(row.classification_id),
      stratum: row.stratum,
      predictedLabel: row.predicted_label,
      reviewedLabel: row.reviewed_label,
      correct: row.predicted_label === row.reviewed_label,
    });
  });
  const reviewerId = options.reviewerId.normalize("NFC").trim();
  if (!/^[A-Za-z0-9_-]{16,200}$/u.test(reviewerId)) {
    throw new TypeError("reviewerId must be a non-identifying opaque identifier of at least 16 characters");
  }
  const reviewedAt = canonicalTimestamp("reviewedAt", options.reviewedAt);
  const now = options.now ?? new Date();
  if (Date.parse(reviewedAt) < Date.parse(sampledAt) || Date.parse(reviewedAt) > now.getTime()) {
    throw new TypeError("Review completion time is outside the allowed evidence window");
  }
  if (reviews.every((row) => !IPCA_CODE.test(row.predictedLabel))) {
    throw new TypeError("Classification precision requires at least one assigned prediction");
  }
  const reviewedLabelsSha256 = sha256(JSON.stringify(reviews.map((row) => ({
    classificationRefSha256: row.classificationRefSha256,
    reviewedLabel: row.reviewedLabel,
  }))));
  return {
    schemaVersion: 1,
    status: "complete",
    classificationVersion: template.classificationVersion,
    sampledAt: template.sampledAt,
    reviewedAt,
    reviewerRefSha256: sha256(reviewerId),
    populationSize: template.populationSize,
    sampleSize: template.sampleSize,
    samplingFrameSha256: template.samplingFrameSha256,
    sampleSha256: template.sampleSha256,
    templateSha256: template.templateSha256,
    reviewedLabelsSha256,
    overall: metric(reviews),
    strata: metricsByStratum(reviews),
    reviews,
  };
}

export function validateClassificationReviewResult(
  database: Database.Database,
  input: unknown,
  options: { now?: Date; requiredSize?: number } = {},
): ClassificationReviewResult {
  const result = ClassificationReviewResultSchema.parse(input);
  const requiredSize = options.requiredSize ?? CLASSIFICATION_REVIEW_SIZE;
  if (result.sampleSize !== requiredSize || result.reviews.length !== result.sampleSize) {
    throw new TypeError(`Classification review result must contain exactly ${requiredSize} reviews`);
  }
  const now = options.now ?? new Date();
  canonicalTimestamp("sampledAt", result.sampledAt);
  canonicalTimestamp("reviewedAt", result.reviewedAt);
  if (Date.parse(result.reviewedAt) < Date.parse(result.sampledAt)
    || Date.parse(result.reviewedAt) > now.getTime()) {
    throw new TypeError("Classification review result time binding is invalid");
  }
  const template = buildClassificationReviewTemplate(database, {
    version: result.classificationVersion,
    sampledAt: result.sampledAt,
    size: result.sampleSize,
  });
  if (result.populationSize !== template.populationSize
    || result.samplingFrameSha256 !== template.samplingFrameSha256
    || result.sampleSha256 !== template.sampleSha256
    || result.templateSha256 !== template.templateSha256) {
    throw new TypeError("Classification review result does not bind the deterministic sample");
  }
  const expected = new Map(template.rows.map((row) => [sha256(row.classificationId), row]));
  const labels = allowedReviewLabels(database);
  const seen = new Set<string>();
  for (const [index, review] of result.reviews.entries()) {
    const row = expected.get(review.classificationRefSha256);
    const expectedRef = template.rows[index] === undefined
      ? null
      : sha256(template.rows[index]!.classificationId);
    if (row === undefined || seen.has(review.classificationRefSha256)) {
      throw new TypeError("Classification review result contains unknown or duplicate references");
    }
    if (review.classificationRefSha256 !== expectedRef) {
      throw new TypeError("Classification review result changed the deterministic sample order");
    }
    seen.add(review.classificationRefSha256);
    if (review.stratum !== row.stratum || review.predictedLabel !== row.predictedLabel
      || !labels.has(review.reviewedLabel)
      || review.correct !== (review.predictedLabel === review.reviewedLabel)) {
      throw new TypeError("Classification review result contains a tampered decision");
    }
  }
  if (seen.size !== expected.size) throw new TypeError("Classification review result is incomplete");
  const labelsHash = sha256(JSON.stringify(result.reviews.map((row) => ({
    classificationRefSha256: row.classificationRefSha256,
    reviewedLabel: row.reviewedLabel,
  }))));
  if (result.reviewedLabelsSha256 !== labelsHash
    || !same(result.overall, metric(result.reviews))
    || !same(result.strata, metricsByStratum(result.reviews))) {
    throw new TypeError("Classification review result metrics or label hash are inconsistent");
  }
  if (result.overall.assigned === 0 || result.overall.precision === null) {
    throw new TypeError("Classification review result has no precision denominator");
  }
  return result;
}

export function readClassificationReviewResult(
  database: Database.Database,
  path: string,
  options: Parameters<typeof validateClassificationReviewResult>[2] = {},
): ClassificationReviewResult {
  return validateClassificationReviewResult(database, JSON.parse(readFileSync(path, "utf8")), options);
}
