import type { ExtractionResult, ProductRef } from "./types.js";
import type { ExtractionStrategy } from "./schema.js";
import { isDescriptiveProductTitle } from "../normalize/title.js";

export interface ValidationReport {
  attempted: number;
  valid: number;
  score: number;
  activatable: boolean;
  samples: Array<{ ref: ProductRef; valid: boolean; reason?: string }>;
}

export type ExtractionStrategyExecutor = (
  strategy: ExtractionStrategy,
  ref: ProductRef,
) => ExtractionResult | Promise<ExtractionResult>;

const ACTIVATION_SAMPLE_SIZE = 30;
const ACTIVATION_SCORE = 0.9;

export function extractionValidationFailureReason(
  result: ExtractionResult,
): string | undefined {
  if (result.ok !== true) {
    return result.failure?.message?.trim() || "Extraction failed";
  }

  const fields = result.fields;
  if (fields === undefined || fields === null || typeof fields !== "object") {
    return "Extraction returned no fields";
  }
  if (!isDescriptiveProductTitle(fields.title)) {
    return "Title must contain descriptive product text";
  }
  if (
    fields.brand !== null &&
    (typeof fields.brand !== "string" || fields.brand.trim().length === 0)
  ) {
    return "Brand must be null or a non-empty string";
  }
  if (
    typeof fields.price !== "number" ||
    !Number.isFinite(fields.price) ||
    fields.price <= 0
  ) {
    return "Price must be a positive finite number";
  }
  if (
    fields.promoPrice !== null &&
    (typeof fields.promoPrice !== "number" ||
      !Number.isFinite(fields.promoPrice) ||
      fields.promoPrice <= 0 ||
      fields.promoPrice > fields.price)
  ) {
    return "Promotional price must be null or positive and no greater than price";
  }
  if (
    fields.unit !== null &&
    (typeof fields.unit !== "string" || fields.unit.trim().length === 0)
  ) {
    return "Unit must be null or a non-empty string";
  }
  if (typeof fields.available !== "boolean") {
    return "Availability must be a boolean";
  }

  return undefined;
}

function thrownReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "Extraction executor threw an unknown error";
}

function uniqueRefs(refs: readonly ProductRef[]): ProductRef[] {
  const seen = new Set<string>();
  const unique: ProductRef[] = [];

  for (const ref of refs) {
    if (!seen.has(ref.canonicalUrl)) {
      seen.add(ref.canonicalUrl);
      unique.push(ref);
    }
  }

  return unique;
}

export async function validateExtractionStrategy(
  strategy: ExtractionStrategy,
  refs: readonly ProductRef[],
  execute: ExtractionStrategyExecutor,
  sampleSize = ACTIVATION_SAMPLE_SIZE,
): Promise<ValidationReport> {
  if (!Number.isSafeInteger(sampleSize) || sampleSize <= 0) {
    throw new RangeError("sampleSize must be a positive safe integer");
  }

  const selectedRefs = uniqueRefs(refs).slice(0, sampleSize);
  const samples: ValidationReport["samples"] = [];
  let valid = 0;

  for (const ref of selectedRefs) {
    try {
      const result = await execute(strategy, ref);
      const reason = extractionValidationFailureReason(result);
      if (reason === undefined) {
        valid += 1;
        samples.push({ ref, valid: true });
      } else {
        samples.push({ ref, valid: false, reason });
      }
    } catch (error) {
      samples.push({ ref, valid: false, reason: thrownReason(error) });
    }
  }

  const attempted = samples.length;
  const score = attempted === 0 ? 0 : valid / attempted;
  const activatable =
    sampleSize === ACTIVATION_SAMPLE_SIZE &&
    attempted === ACTIVATION_SAMPLE_SIZE &&
    score >= ACTIVATION_SCORE;

  return { attempted, valid, score, activatable, samples };
}
