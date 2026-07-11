import type Database from "better-sqlite3";

import type { AlertSink } from "../ops/alerts.js";

export const INDEX_METHOD_VERSION = "tcc-food-at-home-v1" as const;
export const TOTAL_FOOD_AT_HOME_WEIGHT = "12.1181" as const;

export interface BuildDailyIndexOptions {
  throughDay?: string;
  classificationVersion?: number;
  cutoffAt?: string;
}

export interface ProductRelative {
  day: string;
  previousDay: string;
  retailerId: string;
  productId: string;
  ipcaItemId: string;
  ipcaCode: string;
  classificationId: string;
  classificationVersion: number;
  numeratorCents: number;
  denominatorCents: number;
  numeratorSourceDay: string;
  denominatorSourceDay: string;
  numeratorCarried: boolean;
  denominatorCarried: boolean;
  relative: string;
}

export interface RetailerSubitemPoint {
  day: string;
  previousDay: string;
  retailerId: string;
  retailerName: string;
  ipcaItemId: string;
  ipcaCode: string;
  relative: string;
  productPairCount: number;
}

export interface SubitemPoint {
  day: string;
  previousDay: string;
  ipcaItemId: string;
  ipcaCode: string;
  ipcaName: string;
  weightText: string;
  relative: string;
  retailerCount: number;
  productPairCount: number;
  retailerMinRelative: string;
  retailerMaxRelative: string;
}

export interface AggregateIndexPoint {
  day: string;
  previousDay: string | null;
  chainSegment: number;
  dailyRelative: string | null;
  indexLevel: string | null;
  coveredWeightText: string;
  totalFoodAtHomeWeightText: typeof TOTAL_FOOD_AT_HOME_WEIGHT;
  coverageFraction: string;
  coveredSubitemCount: number;
  retailerCount: number;
  productPairCount: number;
  descriptiveLowRelative: string | null;
  descriptiveHighRelative: string | null;
}

export interface CoveragePoint {
  day: string;
  coveredWeightText: string;
  totalFoodAtHomeWeightText: typeof TOTAL_FOOD_AT_HOME_WEIGHT;
  coverageFraction: string;
  coveredSubitemCount: number;
  retailerCount: number;
  productPairCount: number;
  unclassifiedCount: number;
  noHealthyRunCount: number;
  unavailableCount: number;
  carriedExpiredCount: number;
  noDenominatorCount: number;
  invalidPriceCount: number;
}

export interface IndexSeries {
  methodVersion: typeof INDEX_METHOD_VERSION;
  throughDay: string | null;
  classificationVersion: number | null;
  productRelatives: ProductRelative[];
  retailerSubitems: RetailerSubitemPoint[];
  subitems: SubitemPoint[];
  aggregate: AggregateIndexPoint[];
  coverage: CoveragePoint[];
}

export interface OfficialMonthlyPoint {
  month: string;
  variationPct: string;
  variableId: "63";
  territorialLevel: "N7";
  areaCode: "3501";
  areaName: "São Paulo (SP)";
  classificationId: "315";
  categoryId: "7171";
}

export interface MissingOfficialMonth {
  month: string;
  sourceValue: string;
}

export interface SidraFetchResult {
  points: OfficialMonthlyPoint[];
  missingMonths: MissingOfficialMonth[];
  responseSha256: string;
  endpoint: string;
  status: "available" | "no_overlap";
}

export interface SidraClient {
  fetchSeries(startMonth: string, endMonth: string): Promise<SidraFetchResult>;
}

export interface SidraSourceEvidence {
  status: "available" | "no_overlap" | "unavailable";
  endpoint: string;
  responseSha256: string | null;
  fetchedRange: { startMonth: string | null; endMonth: string | null };
  missingMonths: MissingOfficialMonth[];
  error?: string;
}

export interface DatabaseSourceEvidence {
  counts: Record<string, number>;
  maxima: Record<string, string | null>;
}

export interface ExportResearchOptions {
  outputRoot: string;
  now?: () => Date;
  throughDay?: string;
  classificationVersion?: number;
  sidraClient?: SidraClient;
  requireOfficial?: boolean;
  alertSink?: AlertSink;
}

export interface ExportedFileEvidence {
  path: string;
  sha256: string;
  bytes: number;
  rows: number;
  columns: string[];
}

export interface ExportManifest {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  timezone: "America/Sao_Paulo";
  methodVersion: typeof INDEX_METHOD_VERSION;
  status: "complete" | "no_index_data" | "official_unavailable";
  snapshotDirectory: string;
  files: ExportedFileEvidence[];
  sources: {
    ipcaWeights: { rows: number; totalWeight: typeof TOTAL_FOOD_AT_HOME_WEIGHT; archiveSha256: string | null };
    sidra: SidraSourceEvidence;
    database: DatabaseSourceEvidence;
  };
  parameters: {
    promoPreferred: true;
    carryForwardDays: 7;
    withinRetailer: "jevons";
    acrossRetailers: "arithmetic_equal";
    acrossSubitems: "covered_weight_laspeyres_chain";
  };
}

export type ExportResearchFunction = (
  database: Database.Database,
  options: ExportResearchOptions,
) => Promise<ExportManifest>;
