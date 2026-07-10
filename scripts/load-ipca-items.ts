import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";

import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";

export const IPCA_REFERENCE_FILENAME = "ipca_pof2017_2018_sp_food_at_home_weights.csv";
export const OFFICIAL_ARCHIVE_SHA256 = "0ba845113682c96015a0e93daf4b10bc93aad82c2c1d6ea406282af958bf9104";
export const OFFICIAL_SOURCE_URL = "https://ftp.ibge.gov.br/Precos_Indices_de_Precos_ao_Consumidor/IPCA/Atualizacao_das_Estruturas_POF2017-2018/Estruturas_para_divulgacao_dez19.zip";

const EXPECTED_COLUMNS = [
  "pof_vintage",
  "weight_reference_month",
  "effective_from",
  "sidra_area_level",
  "sidra_area_code",
  "area_name",
  "snipc_subgroup_code",
  "sidra_category_id",
  "snipc_subitem_code",
  "subitem_name",
  "weight_pct_total_ipca",
  "source_sheet",
  "source_row",
  "source_url",
  "source_archive_sha256",
] as const;

type CsvColumn = typeof EXPECTED_COLUMNS[number];
type CsvRow = Record<CsvColumn, string>;

export interface IpcaReferenceItem {
  pofVintage: string;
  weightReferenceMonth: string;
  effectiveFrom: string;
  areaLevel: string;
  areaCode: string;
  areaName: string;
  subgroupCode: string;
  categoryId: string;
  code: string;
  name: string;
  group: "alimentação no domicílio";
  weight: number;
  weightText: string;
  sourceSheet: string;
  sourceRow: number;
  sourceUrl: string;
  sourceArchiveSha256: string;
}

function requireText(row: CsvRow, column: CsvColumn, rowNumber: number): string {
  const value = row[column]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${column} citation/provenance at CSV row ${rowNumber}`);
  }
  return value;
}

function validateColumns(records: Record<string, string>[]): void {
  const columns = Object.keys(records[0] ?? {});
  if (
    columns.length !== EXPECTED_COLUMNS.length
    || EXPECTED_COLUMNS.some((column, index) => columns[index] !== column)
  ) {
    throw new Error(`IPCA CSV columns must be exactly: ${EXPECTED_COLUMNS.join(",")}`);
  }
}

export function loadItems(csv: string): IpcaReferenceItem[] {
  const records = parse(csv, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  validateColumns(records);
  if (records.length !== 84) {
    throw new Error(`IPCA reference must contain exactly 84 rows; received ${records.length}`);
  }

  const seenCodes = new Set<string>();
  const items = records.map((record, index): IpcaReferenceItem => {
    const row = record as CsvRow;
    const rowNumber = index + 2;
    for (const column of EXPECTED_COLUMNS) requireText(row, column, rowNumber);

    const subgroupCode = requireText(row, "snipc_subgroup_code", rowNumber);
    const code = requireText(row, "snipc_subitem_code", rowNumber);
    if (subgroupCode !== "1100000" || !/^11\d{5}$/u.test(code) || code === subgroupCode) {
      throw new Error(`Non-food-at-home SNIPC code at CSV row ${rowNumber}`);
    }
    if (seenCodes.has(code)) throw new Error(`Duplicate SNIPC subitem code: ${code}`);
    seenCodes.add(code);

    const weightText = requireText(row, "weight_pct_total_ipca", rowNumber);
    if (!/^(?:0|[1-9]\d*)\.\d{4}$/u.test(weightText)) {
      throw new Error(`Weight must use exactly four decimal places at CSV row ${rowNumber}`);
    }
    let weight: Decimal;
    try {
      weight = new Decimal(weightText);
    } catch {
      throw new Error(`Invalid weight at CSV row ${rowNumber}`);
    }
    if (!weight.isFinite() || weight.isNegative()) {
      throw new Error(`Weight must be non-negative at CSV row ${rowNumber}`);
    }
    const sourceRow = Number(requireText(row, "source_row", rowNumber));
    if (!Number.isSafeInteger(sourceRow) || sourceRow <= 0) {
      throw new Error(`Invalid source_row at CSV row ${rowNumber}`);
    }
    const sourceUrl = requireText(row, "source_url", rowNumber);
    const sourceArchiveSha256 = requireText(row, "source_archive_sha256", rowNumber);
    if (sourceUrl !== OFFICIAL_SOURCE_URL) {
      throw new Error(`Unexpected numeric source URL at CSV row ${rowNumber}`);
    }
    if (sourceArchiveSha256 !== OFFICIAL_ARCHIVE_SHA256) {
      throw new Error(`Unexpected source archive SHA-256 at CSV row ${rowNumber}`);
    }
    const sourceSheet = requireText(row, "source_sheet", rowNumber);
    const areaName = requireText(row, "area_name", rowNumber);
    if (sourceSheet !== "SP" || areaName !== "São Paulo (SP)") {
      throw new Error(`Reference row is not from the official SP sheet at CSV row ${rowNumber}`);
    }

    return {
      pofVintage: requireText(row, "pof_vintage", rowNumber),
      weightReferenceMonth: requireText(row, "weight_reference_month", rowNumber),
      effectiveFrom: requireText(row, "effective_from", rowNumber),
      areaLevel: requireText(row, "sidra_area_level", rowNumber),
      areaCode: requireText(row, "sidra_area_code", rowNumber),
      areaName,
      subgroupCode,
      categoryId: requireText(row, "sidra_category_id", rowNumber),
      code,
      name: requireText(row, "subitem_name", rowNumber),
      group: "alimentação no domicílio",
      weight: weight.toNumber(),
      weightText,
      sourceSheet,
      sourceRow,
      sourceUrl,
      sourceArchiveSha256,
    };
  });

  const total = items.reduce(
    (sum, item) => sum.plus(item.weightText),
    new Decimal(0),
  );
  if (total.minus("12.1181").abs().greaterThan("0.0001")) {
    throw new Error(`IPCA São Paulo food-at-home weights total ${total.toFixed(4)}, expected 12.1181`);
  }
  return items;
}

export interface IpcaLoadResult {
  loaded: number;
  totalWeight: string;
}

export function loadIpcaItems(
  database: Database.Database,
  csv: string,
): IpcaLoadResult {
  const items = loadItems(csv);
  const upsert = database.prepare(`
    INSERT INTO ipca_items
      (id, code, parent_code, name, item_group, weight, weight_period,
       source_url, citation, in_scope, pof_vintage, effective_from, weight_text,
       sidra_area_level, sidra_area_code, area_name, snipc_subgroup_code,
       sidra_category_id, source_sheet, source_row, source_archive_sha256)
    VALUES
      (@id, @code, @parentCode, @name, 'alimentacao_no_domicilio', @weight,
       @weightPeriod, @sourceUrl, @citation, 1, @pofVintage, @effectiveFrom, @weightText,
       @areaLevel, @areaCode, @areaName, @subgroupCode, @categoryId,
       @sourceSheet, @sourceRow, @sourceArchiveSha256)
    ON CONFLICT (code) DO UPDATE SET
      parent_code = excluded.parent_code,
      name = excluded.name,
      item_group = excluded.item_group,
      weight = excluded.weight,
      weight_period = excluded.weight_period,
      source_url = excluded.source_url,
      citation = excluded.citation,
      in_scope = excluded.in_scope,
      pof_vintage = excluded.pof_vintage,
      effective_from = excluded.effective_from,
      weight_text = excluded.weight_text,
      sidra_area_level = excluded.sidra_area_level,
      sidra_area_code = excluded.sidra_area_code,
      area_name = excluded.area_name,
      snipc_subgroup_code = excluded.snipc_subgroup_code,
      sidra_category_id = excluded.sidra_category_id,
      source_sheet = excluded.source_sheet,
      source_row = excluded.source_row,
      source_archive_sha256 = excluded.source_archive_sha256
  `);
  const transaction = database.transaction(() => {
    for (const item of items) {
      upsert.run({
        id: `ipca-sp-${item.code}`,
        code: item.code,
        parentCode: item.subgroupCode,
        name: item.name,
        weight: item.weight,
        weightPeriod: item.weightReferenceMonth,
        weightText: item.weightText,
        sourceUrl: item.sourceUrl,
        citation: `IBGE Estrutura_IPCA.xlsx, sheet ${item.sourceSheet}, row ${item.sourceRow}; archive SHA-256 ${item.sourceArchiveSha256}`,
        pofVintage: item.pofVintage,
        effectiveFrom: item.effectiveFrom,
        areaLevel: item.areaLevel,
        areaCode: item.areaCode,
        areaName: item.areaName,
        subgroupCode: item.subgroupCode,
        categoryId: item.categoryId,
        sourceSheet: item.sourceSheet,
        sourceRow: item.sourceRow,
        sourceArchiveSha256: item.sourceArchiveSha256,
      });
    }
  });
  transaction.immediate();
  const totalWeight = items.reduce(
    (sum, item) => sum.plus(item.weightText),
    new Decimal(0),
  ).toFixed(4);
  return { loaded: items.length, totalWeight };
}

function main(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const config = loadConfig();
  const csvPath = resolve(
    config.projectRoot,
    process.argv[2] ?? `data/reference/${IPCA_REFERENCE_FILENAME}`,
  );
  const database = openDatabase(config.databasePath);
  try {
    const result = loadIpcaItems(database, readFileSync(csvPath, "utf8"));
    process.stdout.write(`${JSON.stringify({ ...result, databasePath: config.databasePath, csvPath })}\n`);
  } finally {
    database.close();
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ipca:load: ${message}\n`);
    process.exitCode = 1;
  }
}
