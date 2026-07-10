export type NormalizedMeasureUnit = "g" | "kg" | "ml" | "l";
export type NormalizedBaseUnit = "kg" | "l";

export interface NormalizedUnit {
  raw: string | null;
  quantity: number | null;
  unit: NormalizedMeasureUnit | null;
  baseQuantity: number | null;
  baseUnit: NormalizedBaseUnit | null;
}

const MEASURE_PATTERN = /(?<![\p{L}\p{N}.,])([+-]?(?:\d[\d.,]*|[.,]\d+))\s*(kg|ml|g|l)(?![\p{L}\p{N}])/giu;

function emptyUnit(raw: string | null): NormalizedUnit {
  return {
    raw,
    quantity: null,
    unit: null,
    baseQuantity: null,
    baseUnit: null,
  };
}

function parseQuantity(value: string): number | null {
  if (!/^(?:\d+(?:[.,]\d{1,2})?|[.,]\d{1,2})$/u.test(value)) {
    return null;
  }

  const normalized = /^[.,]/u.test(value) ? `0${value}` : value;
  const quantity = Number(normalized.replace(",", "."));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

export function normalizeUnit(input: string | null): NormalizedUnit {
  if (input === null) {
    return emptyUnit(null);
  }

  const matches = [...input.matchAll(MEASURE_PATTERN)];
  if (matches.length !== 1) {
    return emptyUnit(input);
  }

  const match = matches[0];
  const quantityText = match?.[1];
  const unitText = match?.[2];
  if (quantityText === undefined || unitText === undefined) {
    return emptyUnit(input);
  }

  const quantity = parseQuantity(quantityText);
  if (quantity === null) {
    return emptyUnit(input);
  }

  const unit = unitText.toLowerCase() as NormalizedMeasureUnit;
  const mass = unit === "g" || unit === "kg";

  return {
    raw: input,
    quantity,
    unit,
    baseQuantity: unit === "g" || unit === "ml" ? quantity / 1_000 : quantity,
    baseUnit: mass ? "kg" : "l",
  };
}
