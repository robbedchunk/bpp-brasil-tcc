import type Database from "better-sqlite3";

import { Decimal } from "decimal.js";

import type { BuildDailyIndexOptions, ProductRelative } from "./types.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
const DAY_MS = 86_400_000;

export interface IndexedProduct {
  productId: string;
  retailerId: string;
  retailerName: string;
  classificationId: string;
  classificationVersion: number;
  ipcaItemId: string;
  ipcaCode: string;
  ipcaName: string;
  weightText: string;
}

export interface ActualPrice {
  day: string;
  observedAt: string;
  available: boolean;
  regularCents: number;
  promoCents: number | null;
}

export interface IndexInput {
  days: string[];
  healthyRetailerDays: Set<string>;
  products: IndexedProduct[];
  actualsByProduct: Map<string, ActualPrice[]>;
  unclassifiedByRetailer: Map<string, number>;
}

export interface EffectivePrice {
  cents: number;
  sourceDay: string;
  carried: boolean;
  carryReason: "missing_observation" | "unavailable" | null;
}

type MissingPriceReason = "unavailable" | "invalid" | "expired" | "absent";

interface PriceResolution {
  price: EffectivePrice | null;
  missingReason: MissingPriceReason | null;
}

export interface DayExclusions {
  unclassifiedCount: number;
  noHealthyRunCount: number;
  unavailableCount: number;
  carriedExpiredCount: number;
  noDenominatorCount: number;
  invalidPriceCount: number;
}

export function strictDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`Invalid collection day: ${value}`);
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  const normalized = new Date(timestamp).toISOString().slice(0, 10);
  if (normalized !== value) throw new Error(`Invalid collection day: ${value}`);
  return value;
}

export function dayDifference(later: string, earlier: string): number {
  strictDay(later);
  strictDay(earlier);
  return Math.round((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / DAY_MS);
}

function healthyRunWhere(alias: string): string {
  return `${alias}.stage = 'collect'
    AND ${alias}.status IN ('completed', 'partial')
    AND ${alias}.finished_at IS NOT NULL
    AND ${alias}.attempted > 0
    AND CAST(${alias}.ok AS REAL) / ${alias}.attempted >= 0.7
    AND COALESCE((
      SELECT state.state
      FROM retailer_state_events state
      WHERE state.retailer_id = ${alias}.retailer_id
        AND state.effective_at <= ${alias}.started_at
      ORDER BY state.effective_at DESC, state.sequence DESC
      LIMIT 1
    ), 'recovered') = 'recovered'`;
}

export function loadIndexInput(
  database: Database.Database,
  options: BuildDailyIndexOptions = {},
): IndexInput {
  const throughDay = options.throughDay === undefined ? undefined : strictDay(options.throughDay);
  const cutoffAt = options.cutoffAt;
  if (cutoffAt !== undefined && (
    !Number.isFinite(Date.parse(cutoffAt)) || new Date(cutoffAt).toISOString() !== cutoffAt
  )) throw new Error("cutoffAt must be a canonical ISO timestamp");
  if (options.classificationVersion !== undefined && (
    !Number.isSafeInteger(options.classificationVersion) || options.classificationVersion <= 0
  )) throw new Error("classificationVersion must be a positive safe integer");

  return database.transaction((): IndexInput => {
    const dayParameters: unknown[] = [];
    const dayLimit = throughDay === undefined ? "" : "AND r.collection_day <= ?";
    if (throughDay !== undefined) dayParameters.push(throughDay);
    const healthyRows = database.prepare(`
      SELECT DISTINCT r.retailer_id, r.collection_day
      FROM runs r
      WHERE ${healthyRunWhere("r")} ${dayLimit}
      ORDER BY r.collection_day, r.retailer_id
    `).all(...dayParameters) as Array<{ retailer_id: string; collection_day: string }>;
    const healthyRetailerDays = new Set(healthyRows.map((row) => `${row.retailer_id}\u0000${strictDay(row.collection_day)}`));
    const days = [...new Set(healthyRows.map((row) => strictDay(row.collection_day)))].sort();

    const versionClause = options.classificationVersion === undefined
      ? ""
      : "AND candidate.version = @classificationVersion";
    const cutoffClause = cutoffAt === undefined
      ? ""
      : "AND candidate.created_at <= @cutoffAt";
    const productRows = database.prepare(`
      SELECT p.id AS product_id, p.retailer_id, retailer.name AS retailer_name,
             c.id AS classification_id, c.version AS classification_version,
             c.ipca_item_id, item.code AS ipca_code, item.name AS ipca_name,
             item.weight_text
      FROM products p
      JOIN retailers retailer ON retailer.id = p.retailer_id
      JOIN classifications c ON c.id = (
        SELECT candidate.id
        FROM classifications candidate
        WHERE candidate.product_id = p.id ${versionClause} ${cutoffClause}
        ORDER BY candidate.version DESC, candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      )
      JOIN ipca_items item ON item.id = c.ipca_item_id AND item.in_scope = 1
      WHERE p.in_scope = 1
      ORDER BY p.retailer_id, p.id
    `).all({
      classificationVersion: options.classificationVersion ?? null,
      cutoffAt: cutoffAt ?? null,
    }) as Array<{
      product_id: string;
      retailer_id: string;
      retailer_name: string;
      classification_id: string;
      classification_version: number;
      ipca_item_id: string;
      ipca_code: string;
      ipca_name: string;
      weight_text: string | null;
    }>;
    const products = productRows.map((row): IndexedProduct => {
      if (row.weight_text === null || !/^(?:0|[1-9]\d*)\.\d{4}$/u.test(row.weight_text)) {
        throw new Error(`IPCA item ${row.ipca_item_id} lacks an exact four-decimal source weight`);
      }
      return {
        productId: row.product_id,
        retailerId: row.retailer_id,
        retailerName: row.retailer_name,
        classificationId: row.classification_id,
        classificationVersion: row.classification_version,
        ipcaItemId: row.ipca_item_id,
        ipcaCode: row.ipca_code,
        ipcaName: row.ipca_name,
        weightText: row.weight_text,
      };
    });

    const observationLimit = throughDay === undefined ? "" : "AND o.collection_day <= @throughDay";
    const observationRows = database.prepare(`
      WITH ranked AS (
        SELECT o.product_id, o.collection_day, o.observed_at, o.available,
               o.price_cents, o.promo_price_cents,
               ROW_NUMBER() OVER (
                 PARTITION BY o.product_id, o.collection_day
                 ORDER BY o.observed_at DESC, o.created_at DESC, o.id DESC
               ) AS position
        FROM observations o
        JOIN runs r ON r.id = o.run_id
        WHERE ${healthyRunWhere("r")} ${observationLimit}
      )
      SELECT product_id, collection_day, observed_at, available,
             price_cents, promo_price_cents
      FROM ranked WHERE position = 1
      ORDER BY product_id, collection_day
    `).all({ throughDay: throughDay ?? null }) as Array<{
      product_id: string;
      collection_day: string;
      observed_at: string;
      available: number;
      price_cents: number;
      promo_price_cents: number | null;
    }>;
    const eligible = new Set(products.map((product) => product.productId));
    const actualsByProduct = new Map<string, ActualPrice[]>();
    for (const row of observationRows) {
      if (!eligible.has(row.product_id)) continue;
      const actuals = actualsByProduct.get(row.product_id) ?? [];
      actuals.push({
        day: strictDay(row.collection_day),
        observedAt: row.observed_at,
        available: row.available === 1,
        regularCents: row.price_cents,
        promoCents: row.promo_price_cents,
      });
      actualsByProduct.set(row.product_id, actuals);
    }

    const unclassifiedRows = database.prepare(`
      SELECT p.retailer_id, COUNT(*) AS count
      FROM products p
      WHERE p.in_scope = 1 AND NOT EXISTS (
        SELECT 1 FROM classifications c
        WHERE c.id = (
          SELECT candidate.id FROM classifications candidate
          WHERE candidate.product_id = p.id ${versionClause} ${cutoffClause}
          ORDER BY candidate.version DESC, candidate.created_at DESC, candidate.id DESC
          LIMIT 1
        ) AND c.ipca_item_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM ipca_items item
          WHERE item.id = c.ipca_item_id AND item.in_scope = 1
        )
      )
      GROUP BY p.retailer_id
    `).all({
      classificationVersion: options.classificationVersion ?? null,
      cutoffAt: cutoffAt ?? null,
    }) as Array<{
      retailer_id: string;
      count: number;
    }>;

    return {
      days,
      healthyRetailerDays,
      products,
      actualsByProduct,
      unclassifiedByRetailer: new Map(unclassifiedRows.map((row) => [row.retailer_id, row.count])),
    };
  }).deferred();
}

function effectiveCents(actual: ActualPrice): number | null {
  if (!actual.available) return null;
  const promo = actual.promoCents;
  if (promo !== null && Number.isSafeInteger(promo) && promo > 0) return promo;
  return Number.isSafeInteger(actual.regularCents) && actual.regularCents > 0
    ? actual.regularCents
    : null;
}

export function effectivePrice(
  actuals: readonly ActualPrice[],
  targetDay: string,
): EffectivePrice | null {
  return resolveEffectivePrice(actuals, targetDay).price;
}

function resolveEffectivePrice(
  actuals: readonly ActualPrice[],
  targetDay: string,
): PriceResolution {
  const sameDay = [...actuals].reverse().find((actual) => actual.day === targetDay);
  if (sameDay !== undefined) {
    if (sameDay.available) {
      const cents = effectiveCents(sameDay);
      return cents === null
        ? { price: null, missingReason: "invalid" }
        : {
            price: {
              cents,
              sourceDay: sameDay.day,
              carried: false,
              carryReason: null,
            },
            missingReason: null,
          };
    }
  }

  for (let index = actuals.length - 1; index >= 0; index -= 1) {
    const actual = actuals[index];
    if (actual === undefined || actual.day >= targetDay) continue;
    const cents = effectiveCents(actual);
    if (cents === null) continue;
    const age = dayDifference(targetDay, actual.day);
    if (age > 7) return { price: null, missingReason: "expired" };
    return {
      price: {
        cents,
        sourceDay: actual.day,
        carried: true,
        carryReason: sameDay === undefined ? "missing_observation" : "unavailable",
      },
      missingReason: null,
    };
  }
  return {
    price: null,
    missingReason: sameDay === undefined ? "absent" : "unavailable",
  };
}

function recordNumeratorExclusion(
  exclusions: DayExclusions,
  reason: MissingPriceReason,
): void {
  if (reason === "unavailable") exclusions.unavailableCount += 1;
  else if (reason === "invalid") exclusions.invalidPriceCount += 1;
  else if (reason === "expired") exclusions.carriedExpiredCount += 1;
  else exclusions.noDenominatorCount += 1;
}

export function buildProductRelativesForDay(
  input: IndexInput,
  day: string,
  previousDay: string,
  exclusions: DayExclusions,
): ProductRelative[] {
  const output: ProductRelative[] = [];
  for (const product of input.products) {
    const todayHealthy = input.healthyRetailerDays.has(`${product.retailerId}\u0000${day}`);
    const previousHealthy = input.healthyRetailerDays.has(`${product.retailerId}\u0000${previousDay}`);
    if (!todayHealthy || !previousHealthy) {
      exclusions.noHealthyRunCount += 1;
      continue;
    }
    const actuals = input.actualsByProduct.get(product.productId) ?? [];
    const numeratorResolution = resolveEffectivePrice(actuals, day);
    if (numeratorResolution.price === null) {
      recordNumeratorExclusion(
        exclusions,
        numeratorResolution.missingReason ?? "absent",
      );
      continue;
    }
    const denominatorResolution = resolveEffectivePrice(actuals, previousDay);
    if (denominatorResolution.price === null) {
      exclusions.noDenominatorCount += 1;
      continue;
    }
    const numerator = numeratorResolution.price;
    const denominator = denominatorResolution.price;
    output.push({
      day,
      previousDay,
      retailerId: product.retailerId,
      productId: product.productId,
      ipcaItemId: product.ipcaItemId,
      ipcaCode: product.ipcaCode,
      classificationId: product.classificationId,
      classificationVersion: product.classificationVersion,
      numeratorCents: numerator.cents,
      denominatorCents: denominator.cents,
      numeratorSourceDay: numerator.sourceDay,
      denominatorSourceDay: denominator.sourceDay,
      numeratorCarried: numerator.carried,
      denominatorCarried: denominator.carried,
      numeratorCarryReason: numerator.carryReason,
      denominatorCarryReason: denominator.carryReason,
      relative: new D(numerator.cents).div(denominator.cents).toFixed(12),
    });
  }
  return output;
}

export function validBaselineProducts(
  input: IndexInput,
  day: string,
  exclusions: DayExclusions,
): IndexedProduct[] {
  const valid: IndexedProduct[] = [];
  for (const product of input.products) {
    if (!input.healthyRetailerDays.has(`${product.retailerId}\u0000${day}`)) {
      exclusions.noHealthyRunCount += 1;
      continue;
    }
    const resolution = resolveEffectivePrice(
      input.actualsByProduct.get(product.productId) ?? [],
      day,
    );
    if (resolution.price === null) {
      recordNumeratorExclusion(exclusions, resolution.missingReason ?? "absent");
      continue;
    }
    valid.push(product);
  }
  return valid;
}
