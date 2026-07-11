import type Database from "better-sqlite3";

import { Decimal } from "decimal.js";

import {
  buildProductRelativesForDay,
  dayDifference,
  loadIndexInput,
  validBaselineProducts,
  type DayExclusions,
  type IndexedProduct,
} from "./relatives.js";
import {
  INDEX_METHOD_VERSION,
  TOTAL_FOOD_AT_HOME_WEIGHT,
  type AggregateIndexPoint,
  type BuildDailyIndexOptions,
  type CoveragePoint,
  type IndexSeries,
  type ProductRelative,
  type RetailerSubitemPoint,
  type SubitemPoint,
} from "./types.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

function blankExclusions(unclassifiedCount = 0): DayExclusions {
  return {
    unclassifiedCount,
    noHealthyRunCount: 0,
    unavailableCount: 0,
    carriedExpiredCount: 0,
    noDenominatorCount: 0,
    invalidPriceCount: 0,
  };
}

function geometricMean(values: readonly string[]): Decimal {
  const sum = values.reduce((total, value) => total.plus(new D(value).ln()), new D(0));
  return sum.div(values.length).exp();
}

function itemMetadata(products: readonly IndexedProduct[]): Map<string, IndexedProduct> {
  const map = new Map<string, IndexedProduct>();
  for (const product of products) map.set(product.ipcaItemId, product);
  return map;
}

function aggregateRelatives(
  relatives: readonly ProductRelative[],
  products: readonly IndexedProduct[],
): { retailerPoints: RetailerSubitemPoint[]; subitemPoints: SubitemPoint[] } {
  const metadata = itemMetadata(products);
  const retailerGroups = new Map<string, ProductRelative[]>();
  for (const relative of relatives) {
    const key = `${relative.day}\u0000${relative.retailerId}\u0000${relative.ipcaItemId}`;
    const group = retailerGroups.get(key) ?? [];
    group.push(relative);
    retailerGroups.set(key, group);
  }
  const retailerPoints = [...retailerGroups.values()].map((group): RetailerSubitemPoint => {
    const first = group[0];
    if (first === undefined) throw new Error("Empty retailer relative group");
    return {
      day: first.day,
      previousDay: first.previousDay,
      retailerId: first.retailerId,
      ipcaItemId: first.ipcaItemId,
      ipcaCode: first.ipcaCode,
      relative: geometricMean(group.map((value) => value.relative)).toFixed(12),
      productPairCount: group.length,
    };
  }).sort((left, right) =>
    left.day.localeCompare(right.day) || left.ipcaCode.localeCompare(right.ipcaCode)
    || left.retailerId.localeCompare(right.retailerId));

  const itemGroups = new Map<string, RetailerSubitemPoint[]>();
  for (const point of retailerPoints) {
    const key = `${point.day}\u0000${point.ipcaItemId}`;
    const group = itemGroups.get(key) ?? [];
    group.push(point);
    itemGroups.set(key, group);
  }
  const subitemPoints = [...itemGroups.values()].map((group): SubitemPoint => {
    const first = group[0];
    if (first === undefined) throw new Error("Empty subitem relative group");
    const item = metadata.get(first.ipcaItemId);
    if (item === undefined) throw new Error(`Missing IPCA metadata for ${first.ipcaItemId}`);
    const values = group.map((point) => new D(point.relative));
    return {
      day: first.day,
      previousDay: first.previousDay,
      ipcaItemId: first.ipcaItemId,
      ipcaCode: item.ipcaCode,
      ipcaName: item.ipcaName,
      weightText: item.weightText,
      relative: values.reduce((sum, value) => sum.plus(value), new D(0)).div(values.length).toFixed(12),
      retailerCount: group.length,
      productPairCount: group.reduce((sum, point) => sum + point.productPairCount, 0),
      retailerMinRelative: D.min(...values).toFixed(12),
      retailerMaxRelative: D.max(...values).toFixed(12),
    };
  }).sort((left, right) => left.day.localeCompare(right.day) || left.ipcaCode.localeCompare(right.ipcaCode));
  return { retailerPoints, subitemPoints };
}

function coveragePoint(
  day: string,
  items: readonly SubitemPoint[],
  retailerCount: number,
  pairCount: number,
  exclusions: DayExclusions,
): CoveragePoint {
  const covered = items.reduce((sum, item) => sum.plus(item.weightText), new D(0));
  return {
    day,
    coveredWeightText: covered.toFixed(4),
    totalFoodAtHomeWeightText: TOTAL_FOOD_AT_HOME_WEIGHT,
    coverageFraction: covered.div(TOTAL_FOOD_AT_HOME_WEIGHT).toFixed(12),
    coveredSubitemCount: items.length,
    retailerCount,
    productPairCount: pairCount,
    ...exclusions,
  };
}

function baselinePoint(
  day: string,
  segment: number,
  products: readonly IndexedProduct[],
  exclusions: DayExclusions,
): { aggregate: AggregateIndexPoint; coverage: CoveragePoint } | null {
  if (products.length === 0) return null;
  const byItem = new Map<string, IndexedProduct>();
  const retailers = new Set<string>();
  for (const product of products) {
    byItem.set(product.ipcaItemId, product);
    retailers.add(product.retailerId);
  }
  const covered = [...byItem.values()].reduce((sum, item) => sum.plus(item.weightText), new D(0));
  const aggregate: AggregateIndexPoint = {
    day,
    previousDay: null,
    chainSegment: segment,
    dailyRelative: null,
    indexLevel: "100.000000000000",
    coveredWeightText: covered.toFixed(4),
    totalFoodAtHomeWeightText: TOTAL_FOOD_AT_HOME_WEIGHT,
    coverageFraction: covered.div(TOTAL_FOOD_AT_HOME_WEIGHT).toFixed(12),
    coveredSubitemCount: byItem.size,
    retailerCount: retailers.size,
    productPairCount: 0,
    descriptiveLowRelative: null,
    descriptiveHighRelative: null,
  };
  return {
    aggregate,
    coverage: {
      day,
      coveredWeightText: aggregate.coveredWeightText,
      totalFoodAtHomeWeightText: TOTAL_FOOD_AT_HOME_WEIGHT,
      coverageFraction: aggregate.coverageFraction,
      coveredSubitemCount: aggregate.coveredSubitemCount,
      retailerCount: aggregate.retailerCount,
      productPairCount: 0,
      ...exclusions,
    },
  };
}

export function buildDailyIndex(
  database: Database.Database,
  options: BuildDailyIndexOptions = {},
): IndexSeries {
  const input = loadIndexInput(database, options);
  const productRelatives: ProductRelative[] = [];
  const retailerSubitems: RetailerSubitemPoint[] = [];
  const subitems: SubitemPoint[] = [];
  const aggregate: AggregateIndexPoint[] = [];
  const coverage: CoveragePoint[] = [];
  let segment = 0;
  let needsBaseline = true;
  let previousLevel: Decimal | null = null;
  let previousDay: string | null = null;

  for (const day of input.days) {
    const unclassified = [...input.unclassifiedByRetailer.entries()]
      .filter(([retailerId]) => input.healthyRetailerDays.has(`${retailerId}\u0000${day}`))
      .reduce((sum, [, count]) => sum + count, 0);
    const exclusions = blankExclusions(unclassified);
    if (previousDay === null || dayDifference(day, previousDay) !== 1) needsBaseline = true;
    if (needsBaseline) {
      const valid = validBaselineProducts(input, day);
      const baseline = baselinePoint(day, segment + 1, valid, exclusions);
      if (baseline !== null) {
        segment += 1;
        aggregate.push(baseline.aggregate);
        coverage.push(baseline.coverage);
        previousLevel = new D(100);
        needsBaseline = false;
      } else {
        coverage.push(coveragePoint(day, [], 0, 0, exclusions));
        previousLevel = null;
      }
      previousDay = day;
      continue;
    }

    if (previousDay === null) throw new Error("Missing previous index day");
    const relatives = buildProductRelativesForDay(input, day, previousDay, exclusions);
    const grouped = aggregateRelatives(relatives, input.products);
    const todayItems = grouped.subitemPoints.filter((point) => point.day === day);
    const retailerIds = new Set(relatives.map((relative) => relative.retailerId));
    productRelatives.push(...relatives);
    retailerSubitems.push(...grouped.retailerPoints);
    subitems.push(...todayItems);
    const todayCoverage = coveragePoint(day, todayItems, retailerIds.size, relatives.length, exclusions);
    coverage.push(todayCoverage);
    if (todayItems.length === 0 || previousLevel === null) {
      aggregate.push({
        day,
        previousDay,
        chainSegment: segment,
        dailyRelative: null,
        indexLevel: null,
        coveredWeightText: "0.0000",
        totalFoodAtHomeWeightText: TOTAL_FOOD_AT_HOME_WEIGHT,
        coverageFraction: "0.000000000000",
        coveredSubitemCount: 0,
        retailerCount: 0,
        productPairCount: 0,
        descriptiveLowRelative: null,
        descriptiveHighRelative: null,
      });
      previousLevel = null;
      needsBaseline = true;
      previousDay = day;
      continue;
    }
    const coveredWeight = todayItems.reduce((sum, item) => sum.plus(item.weightText), new D(0));
    const weighted = todayItems.reduce(
      (sum, item) => sum.plus(new D(item.relative).mul(item.weightText)),
      new D(0),
    ).div(coveredWeight);
    const withDispersion = todayItems.every((item) => item.retailerCount >= 2);
    const low = withDispersion
      ? todayItems.reduce((sum, item) => sum.plus(new D(item.retailerMinRelative).mul(item.weightText)), new D(0)).div(coveredWeight)
      : null;
    const high = withDispersion
      ? todayItems.reduce((sum, item) => sum.plus(new D(item.retailerMaxRelative).mul(item.weightText)), new D(0)).div(coveredWeight)
      : null;
    previousLevel = previousLevel.mul(weighted);
    aggregate.push({
      day,
      previousDay,
      chainSegment: segment,
      dailyRelative: weighted.toFixed(12),
      indexLevel: previousLevel.toFixed(12),
      coveredWeightText: coveredWeight.toFixed(4),
      totalFoodAtHomeWeightText: TOTAL_FOOD_AT_HOME_WEIGHT,
      coverageFraction: coveredWeight.div(TOTAL_FOOD_AT_HOME_WEIGHT).toFixed(12),
      coveredSubitemCount: todayItems.length,
      retailerCount: retailerIds.size,
      productPairCount: relatives.length,
      descriptiveLowRelative: low?.toFixed(12) ?? null,
      descriptiveHighRelative: high?.toFixed(12) ?? null,
    });
    previousDay = day;
  }

  return {
    methodVersion: INDEX_METHOD_VERSION,
    throughDay: options.throughDay ?? input.days.at(-1) ?? null,
    classificationVersion: options.classificationVersion ?? null,
    productRelatives,
    retailerSubitems,
    subitems,
    aggregate,
    coverage,
  };
}
