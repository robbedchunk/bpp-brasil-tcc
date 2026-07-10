import { JSONPath } from "jsonpath-plus";

import { parseBrl } from "../normalize/brl.js";
import { normalizeUnit } from "../normalize/unit.js";
import type { FieldMap } from "../strategies/schema.js";
import type { ExtractionResult } from "../strategies/types.js";

export interface RawExtractionFields {
  title: unknown;
  brand: unknown;
  price: unknown;
  promoPrice: unknown;
  unit: unknown;
  availability: unknown;
}

function failed(
  category: "invalid-price" | "missing-fields" | "parse",
  message: string,
): ExtractionResult {
  return {
    ok: false,
    failure: { category, message, responded: true },
  };
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > 0 ? text : null;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string" && value.trim().length === 0);
}

function mappedAvailability(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;

  const normalized = value
    .trim()
    .toLocaleLowerCase("pt-BR")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[\s_-]+/gu, "")
    .replace(/^.*[\/#]/u, "");
  const available = new Set([
    "1",
    "available",
    "backorder",
    "disponivel",
    "emestoque",
    "instock",
    "limitedavailability",
    "onlineonly",
    "preorder",
    "sim",
    "true",
    "yes",
  ]);
  const unavailable = new Set([
    "0",
    "discontinued",
    "false",
    "indisponivel",
    "nao",
    "naodisponivel",
    "naoemestoque",
    "no",
    "outofstock",
    "semestoque",
    "soldout",
    "unavailable",
  ]);

  if (available.has(normalized)) return true;
  if (unavailable.has(normalized)) return false;
  return null;
}

export function mapExtractionFields(
  raw: RawExtractionFields,
): ExtractionResult {
  const title = normalizedText(raw.title);
  if (title === null) {
    return failed("missing-fields", "A non-empty product title is required");
  }

  if (isEmptyValue(raw.price)) {
    return failed("missing-fields", "A regular price is required");
  }
  const price = parseBrl(raw.price);
  if (price === null) {
    return failed("invalid-price", "Regular price must be positive and finite");
  }

  let promoPrice: number | null = null;
  if (!isEmptyValue(raw.promoPrice)) {
    promoPrice = parseBrl(raw.promoPrice);
    if (promoPrice === null) {
      return failed(
        "invalid-price",
        "Promotional price must be positive and finite when present",
      );
    }
    if (promoPrice > price) {
      return failed(
        "invalid-price",
        "Promotional price cannot exceed the regular price",
      );
    }
  }

  const available = mappedAvailability(raw.availability);
  if (available === null) {
    return failed(
      "missing-fields",
      "Availability must map to an explicit boolean value",
    );
  }

  const unitText = normalizedText(raw.unit);
  const unit = unitText === null ? null : normalizeUnit(unitText).raw;

  return {
    ok: true,
    fields: {
      title,
      brand: normalizedText(raw.brand),
      price,
      promoPrice,
      unit,
      available,
    },
  };
}

function jsonPathValue(document: unknown, path: string): unknown {
  const values = JSONPath<unknown[]>({
    path,
    json: document as null | boolean | number | string | object | unknown[],
    resultType: "value",
    wrap: true,
    eval: false,
  });
  return values[0];
}

export function mapJsonExtractionFields(
  document: unknown,
  fields: FieldMap,
): ExtractionResult {
  try {
    return mapExtractionFields({
      title: jsonPathValue(document, fields.title),
      brand: jsonPathValue(document, fields.brand),
      price: jsonPathValue(document, fields.price),
      promoPrice: jsonPathValue(document, fields.promoPrice),
      unit: jsonPathValue(document, fields.unit),
      availability: jsonPathValue(document, fields.availability),
    });
  } catch (error) {
    return failed(
      "parse",
      error instanceof Error ? error.message : "JSONPath evaluation failed",
    );
  }
}
