import { createHash } from "node:crypto";

import type {
  MissingOfficialMonth,
  OfficialMonthlyPoint,
  SidraClient,
  SidraFetchResult,
} from "./types.js";

export const SIDRA_ENDPOINT = "https://servicodados.ibge.gov.br/api/v3/agregados/7060/periodos/all/variaveis/63?localidades=N7%5B3501%5D&classificacao=315%5B7171%5D";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const DECIMAL_VALUE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const PERIOD = /^(\d{4})(0[1-9]|1[0-2])$/u;
const SPECIAL_VALUE = /^(?:-|\.\.|\.\.\.|X|[A-WY-Z])$/u;
const JSON_MEDIA_TYPE = /^\s*application\/json(?:\s*;[\s\S]*)?\s*$/iu;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`SIDRA ${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`SIDRA ${label} must be an array`);
  return value;
}

function exact(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`Unexpected SIDRA ${label}: ${String(value)}`);
}

function validateMonth(month: string): string {
  if (!MONTH.test(month)) throw new Error(`Invalid SIDRA month boundary: ${month}`);
  return month;
}

function periodToMonth(period: string): string {
  const match = PERIOD.exec(period);
  if (match === null) throw new Error(`Invalid SIDRA period key: ${period}`);
  return `${match[1]}-${match[2]}`;
}

function jsonStringAt(text: string, start: number): { value: string; end: number } {
  if (text[start] !== '"') throw new Error("SIDRA JSON string was expected");
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const token = text.slice(start, index + 1);
      return { value: JSON.parse(token) as string, end: index + 1 };
    }
  }
  throw new Error("SIDRA response contains an unterminated JSON string");
}

function whitespaceEnd(text: string, start: number): number {
  let index = start;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

function jsonValueEnd(text: string, start: number): number {
  if (text[start] === '"') return jsonStringAt(text, start).end;
  if (text[start] === "{" || text[start] === "[") {
    const stack = [text[start]];
    let index = start + 1;
    while (index < text.length && stack.length > 0) {
      const character = text[index];
      if (character === '"') {
        index = jsonStringAt(text, index).end;
        continue;
      }
      if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") stack.pop();
      index += 1;
    }
    if (stack.length !== 0) throw new Error("SIDRA response contains an unterminated JSON value");
    return index;
  }
  let index = start;
  while (index < text.length && !/[\s,}\]]/u.test(text[index] ?? "")) index += 1;
  return index;
}

function assertUniqueRawSeriesKeys(text: string): void {
  for (let index = 0; index < text.length;) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const property = jsonStringAt(text, index);
    index = property.end;
    let cursor = whitespaceEnd(text, property.end);
    if (property.value !== "serie" || text[cursor] !== ":") continue;
    cursor = whitespaceEnd(text, cursor + 1);
    if (text[cursor] !== "{") continue;
    cursor = whitespaceEnd(text, cursor + 1);
    const keys = new Set<string>();
    while (cursor < text.length && text[cursor] !== "}") {
      const key = jsonStringAt(text, cursor);
      if (keys.has(key.value)) {
        const label = PERIOD.test(key.value) ? periodToMonth(key.value) : key.value;
        throw new Error(`Duplicate SIDRA month key in raw serie: ${label}`);
      }
      keys.add(key.value);
      cursor = whitespaceEnd(text, key.end);
      if (text[cursor] !== ":") throw new Error("SIDRA serie contains an invalid JSON member");
      cursor = whitespaceEnd(text, cursor + 1);
      cursor = whitespaceEnd(text, jsonValueEnd(text, cursor));
      if (text[cursor] === ",") cursor = whitespaceEnd(text, cursor + 1);
      else if (text[cursor] !== "}") throw new Error("SIDRA serie contains invalid JSON separators");
    }
  }
}

export function parseOfficialSeries(
  body: Uint8Array,
  startMonth: string,
  endMonth: string,
): SidraFetchResult {
  const start = validateMonth(startMonth);
  const end = validateMonth(endMonth);
  if (start > end) throw new Error("SIDRA startMonth must not exceed endMonth");
  if (body.byteLength > MAX_BODY_BYTES) throw new Error("SIDRA response exceeds the 2 MiB size limit");
  const responseSha256 = createHash("sha256").update(body).digest("hex");
  const text = Buffer.from(body).toString("utf8");
  assertUniqueRawSeriesKeys(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("SIDRA response is not valid JSON");
  }
  const roots = array(parsed, "root");
  if (roots.length !== 1) throw new Error("SIDRA response must contain one variable");
  const root = record(roots[0], "variable");
  exact(root.id, "63", "variable ID");
  exact(root.variavel, "IPCA - Variação mensal", "variable name");
  exact(root.unidade, "%", "unit");
  const results = array(root.resultados, "results");
  if (results.length !== 1) throw new Error("SIDRA response must contain one result");
  const result = record(results[0], "result");
  const classifications = array(result.classificacoes, "classifications");
  if (classifications.length !== 1) throw new Error("SIDRA response must contain classification 315 only");
  const classification = record(classifications[0], "classification");
  exact(classification.id, "315", "classification ID");
  const category = record(classification.categoria, "category");
  const categoryKeys = Object.keys(category);
  if (categoryKeys.length !== 1) throw new Error("SIDRA response must contain category 7171 only");
  exact(category["7171"], "11.Alimentação no domicílio", "category 7171");
  const series = array(result.series, "series");
  if (series.length !== 1) throw new Error("SIDRA response must contain one locality series");
  const selected = record(series[0], "series entry");
  const locality = record(selected.localidade, "locality");
  exact(locality.id, "3501", "area code");
  exact(locality.nome, "São Paulo (SP)", "area name");
  const level = record(locality.nivel, "territorial level");
  exact(level.id, "N7", "territorial level ID");
  exact(level.nome, "Região Metropolitana até 2020", "territorial level name");
  const values = record(selected.serie, "monthly series");
  const points: OfficialMonthlyPoint[] = [];
  const missingMonths: MissingOfficialMonth[] = [];
  const seen = new Set<string>();
  for (const [period, sourceValue] of Object.entries(values)) {
    const month = periodToMonth(period);
    if (seen.has(month)) throw new Error(`Duplicate SIDRA month: ${month}`);
    seen.add(month);
    if (month < start || month > end) continue;
    if (typeof sourceValue !== "string") throw new Error(`SIDRA ${month} value must be text`);
    if (SPECIAL_VALUE.test(sourceValue)) {
      missingMonths.push({ month, sourceValue });
      continue;
    }
    if (!DECIMAL_VALUE.test(sourceValue) || !Number.isFinite(Number(sourceValue))) {
      throw new Error(`Invalid SIDRA numeric value for ${month}`);
    }
    points.push({
      month,
      variationPct: sourceValue,
      variableId: "63",
      territorialLevel: "N7",
      areaCode: "3501",
      areaName: "São Paulo (SP)",
      classificationId: "315",
      categoryId: "7171",
    });
  }
  points.sort((left, right) => left.month.localeCompare(right.month));
  missingMonths.sort((left, right) => left.month.localeCompare(right.month));
  return {
    points,
    missingMonths,
    responseSha256,
    endpoint: SIDRA_ENDPOINT,
    status: points.length === 0 ? "no_overlap" : "available",
  };
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new Error("SIDRA response content-length exceeds the 2 MiB size limit");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("SIDRA response exceeds the 2 MiB size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function fetchOfficialSeries(
  fetchImpl: typeof fetch,
  startMonth: string,
  endMonth: string,
): Promise<SidraFetchResult> {
  validateMonth(startMonth);
  validateMonth(endMonth);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(SIDRA_ENDPOINT, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "bpp-brasil-tcc/0.1 academic-price-research",
        },
      });
      if (response.status !== 200) throw new Error(`SIDRA returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!JSON_MEDIA_TYPE.test(contentType)) throw new Error("SIDRA returned a non-JSON content type");
      return parseOfficialSeries(await boundedBytes(response), startMonth, endMonth);
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export class OfficialSidraClient implements SidraClient {
  readonly #fetch: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.#fetch = fetchImpl;
  }

  fetchSeries(startMonth: string, endMonth: string): Promise<SidraFetchResult> {
    return fetchOfficialSeries(this.#fetch, startMonth, endMonth);
  }
}
