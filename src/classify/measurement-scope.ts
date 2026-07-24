import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { ClassificationResult } from "./provider.js";

export const CLASSIFICATION_SCOPE_POLICY_VERSION =
  "ipca-84-classification-scope-v1";

const REVIEW_REQUIRED_RATIONALE_TERMS = new Set([
  "ambiguous",
  "generic",
  "insufficient",
  "review",
  "uncertain",
  "unclear",
  "unknown",
]);

function rationaleTerms(value: string): string[] {
  return value
    .trim()
    .toLocaleLowerCase("en")
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/**
 * An explicit null is scope evidence only when the model is confident that no
 * supplied official item applies. Low-confidence suggestions and rationales
 * that explicitly ask for judgment stay in the denominator for human review.
 */
export function isDefinitivelyOutsideMeasurementFrame(
  result: ClassificationResult,
  confidenceThreshold: number,
): boolean {
  return result.ipcaItemId === null
    && result.confidence >= confidenceThreshold
    && !rationaleTerms(result.rationaleCode)
      .some((term) => REVIEW_REQUIRED_RATIONALE_TERMS.has(term));
}

interface ScopeCandidate {
  classificationId: string;
  productId: string;
  classificationVersion: number;
  confidence: number;
  outputJson: string;
}

export interface ClassificationScopeReconciliation {
  version: number;
  considered: number;
  excluded: number;
  retainedForReview: number;
  policyVersion: typeof CLASSIFICATION_SCOPE_POLICY_VERSION;
}

/**
 * Applies the narrower 84-subitem measurement frame to already-classified
 * products. The classification remains immutable; the exclusion is a separate
 * append-only fact, and rediscovery cannot silently erase it.
 */
export function reconcileClassificationMeasurementScope(
  database: Database.Database,
  input: {
    version: number;
    confidenceThreshold: number;
    decidedAt: string;
    id?: () => string;
  },
): ClassificationScopeReconciliation {
  const candidates = database.prepare(`
    SELECT classification.id AS classificationId,
      classification.product_id AS productId,
      classification.version AS classificationVersion,
      classification.confidence,
      classification.output_json AS outputJson
    FROM classifications AS classification
    JOIN products AS product ON product.id = classification.product_id
    WHERE classification.version = ?
      AND classification.ipca_item_id IS NULL
      AND product.active = 1
      AND product.in_scope = 1
      AND NOT EXISTS (
        SELECT 1 FROM classification_scope_decisions AS decision
        WHERE decision.classification_id = classification.id
      )
    ORDER BY classification.product_id, classification.id
  `).all(input.version) as ScopeCandidate[];
  const makeId = input.id ?? randomUUID;
  let excluded = 0;
  let retainedForReview = 0;
  const apply = database.transaction(() => {
    const insert = database.prepare(`
      INSERT INTO classification_scope_decisions
        (id, product_id, classification_id, classification_version, action,
         reason, rationale_code, confidence, policy_version, decided_at)
      VALUES
        (?, ?, ?, ?, 'excluded', 'outside_ipca_measurement_frame',
         ?, ?, ?, ?)
    `);
    const exclude = database.prepare(`
      UPDATE products
      SET in_scope = 0,
          current_ipca_item_id = NULL,
          updated_at = ?
      WHERE id = ? AND active = 1 AND in_scope = 1
    `);
    for (const candidate of candidates) {
      let result: ClassificationResult;
      try {
        const parsed = JSON.parse(candidate.outputJson) as Partial<ClassificationResult>;
        if (
          parsed.ipcaItemId !== null
          || typeof parsed.confidence !== "number"
          || parsed.confidence !== candidate.confidence
          || typeof parsed.rationaleCode !== "string"
          || parsed.rationaleCode.trim().length === 0
        ) {
          retainedForReview += 1;
          continue;
        }
        result = {
          productId: candidate.productId,
          ipcaItemId: null,
          confidence: parsed.confidence,
          rationaleCode: parsed.rationaleCode,
        };
      } catch {
        retainedForReview += 1;
        continue;
      }
      if (!isDefinitivelyOutsideMeasurementFrame(
        result,
        input.confidenceThreshold,
      )) {
        retainedForReview += 1;
        continue;
      }
      const changed = exclude.run(input.decidedAt, candidate.productId).changes;
      if (changed !== 1) continue;
      insert.run(
        makeId(),
        candidate.productId,
        candidate.classificationId,
        candidate.classificationVersion,
        result.rationaleCode,
        result.confidence,
        CLASSIFICATION_SCOPE_POLICY_VERSION,
        input.decidedAt,
      );
      excluded += 1;
    }
  });
  apply.immediate();
  return {
    version: input.version,
    considered: candidates.length,
    excluded,
    retainedForReview,
    policyVersion: CLASSIFICATION_SCOPE_POLICY_VERSION,
  };
}
