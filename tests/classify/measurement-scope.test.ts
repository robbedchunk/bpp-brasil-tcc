import { describe, expect, it } from "vitest";

import {
  CLASSIFICATION_SCOPE_POLICY_VERSION,
  isDefinitivelyOutsideMeasurementFrame,
  reconcileClassificationMeasurementScope,
} from "../../src/classify/measurement-scope.js";
import { openDatabase } from "../../src/db/database.js";
import { upsertDiscoveredProduct } from "../../src/db/repositories.js";

function seedProduct(
  database: ReturnType<typeof openDatabase>,
  id: string,
): void {
  database.prepare(`
    INSERT INTO products
      (id, retailer_id, canonical_url, title, source_category,
       descriptive_title, first_seen, last_seen)
    VALUES
      (?, 'retailer', ?, ?, 'Alimentos', 1,
       '2026-07-24T12:00:00.000Z', '2026-07-24T12:00:00.000Z')
  `).run(id, `https://mercado.test/${id}`, `Produto ${id}`);
}

function seedClassification(
  database: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    productId: string;
    confidence: number;
    ipcaItemId: string | null;
    rationaleCode: string;
  },
): void {
  database.prepare(`
    INSERT INTO classifications
      (id, product_id, ipca_item_id, version, decision, confidence, method,
       output_json, created_at)
    VALUES
      (?, ?, NULL, 1, 'unclassified', ?, 'llm', ?, '2026-07-24T13:00:00.000Z')
  `).run(
    input.id,
    input.productId,
    input.confidence,
    JSON.stringify({
      productId: input.productId,
      ipcaItemId: input.ipcaItemId,
      confidence: input.confidence,
      rationaleCode: input.rationaleCode,
    }),
  );
}

function database(): ReturnType<typeof openDatabase> {
  const result = openDatabase(":memory:");
  result.exec(`
    INSERT INTO retailers
      (id, name, base_url, cep, domains_json)
    VALUES
      ('retailer', 'Mercado', 'https://mercado.test', '01310-100',
       '["mercado.test"]');
  `);
  return result;
}

describe("classification measurement scope", () => {
  it("excludes only a high-confidence explicit null that does not require review", () => {
    expect(isDefinitivelyOutsideMeasurementFrame({
      productId: "outside",
      ipcaItemId: null,
      confidence: 0.98,
      rationaleCode: "outside_allowed_item",
    }, 0.8)).toBe(true);
    expect(isDefinitivelyOutsideMeasurementFrame({
      productId: "ambiguous",
      ipcaItemId: null,
      confidence: 0.98,
      rationaleCode: "ambiguous_food_match",
    }, 0.8)).toBe(false);
    expect(isDefinitivelyOutsideMeasurementFrame({
      productId: "low",
      ipcaItemId: null,
      confidence: 0.79,
      rationaleCode: "outside_allowed_item",
    }, 0.8)).toBe(false);
  });

  it("records an immutable exclusion and keeps unresolved rows in the denominator", () => {
    const db = database();
    try {
      for (const id of ["outside", "ambiguous", "low-suggestion"]) {
        seedProduct(db, id);
      }
      seedClassification(db, {
        id: "classification-outside",
        productId: "outside",
        confidence: 0.98,
        ipcaItemId: null,
        rationaleCode: "outside_allowed_item",
      });
      seedClassification(db, {
        id: "classification-ambiguous",
        productId: "ambiguous",
        confidence: 0.95,
        ipcaItemId: null,
        rationaleCode: "ambiguous_product",
      });
      seedClassification(db, {
        id: "classification-low",
        productId: "low-suggestion",
        confidence: 0.75,
        ipcaItemId: "ipca-arroz",
        rationaleCode: "closest_food_match",
      });

      const first = reconcileClassificationMeasurementScope(db, {
        version: 1,
        confidenceThreshold: 0.8,
        decidedAt: "2026-07-24T14:00:00.000Z",
        id: () => "scope-outside",
      });
      const second = reconcileClassificationMeasurementScope(db, {
        version: 1,
        confidenceThreshold: 0.8,
        decidedAt: "2026-07-24T14:01:00.000Z",
      });

      expect(first).toEqual({
        version: 1,
        considered: 3,
        excluded: 1,
        retainedForReview: 2,
        policyVersion: CLASSIFICATION_SCOPE_POLICY_VERSION,
      });
      expect(second).toMatchObject({
        considered: 2,
        excluded: 0,
        retainedForReview: 2,
      });
      expect(db.prepare(`
        SELECT id, in_scope AS inScope
        FROM products ORDER BY id
      `).all()).toEqual([
        { id: "ambiguous", inScope: 1 },
        { id: "low-suggestion", inScope: 1 },
        { id: "outside", inScope: 0 },
      ]);
      expect(db.prepare(`
        SELECT classification_id AS classificationId, reason, rationale_code AS rationaleCode,
          confidence, policy_version AS policyVersion
        FROM classification_scope_decisions
      `).get()).toEqual({
        classificationId: "classification-outside",
        reason: "outside_ipca_measurement_frame",
        rationaleCode: "outside_allowed_item",
        confidence: 0.98,
        policyVersion: CLASSIFICATION_SCOPE_POLICY_VERSION,
      });
      expect(() => db.prepare(`
        UPDATE classification_scope_decisions SET confidence = 0.99
      `).run()).toThrow(/immutable/iu);
      expect(() => db.prepare(`
        DELETE FROM classification_scope_decisions
      `).run()).toThrow(/append-only/iu);
    } finally {
      db.close();
    }
  });

  it("does not let rediscovery silently restore an IPCA-frame exclusion", () => {
    const db = database();
    try {
      seedProduct(db, "outside");
      seedClassification(db, {
        id: "classification-outside",
        productId: "outside",
        confidence: 0.99,
        ipcaItemId: null,
        rationaleCode: "no_allowed_match",
      });
      reconcileClassificationMeasurementScope(db, {
        version: 1,
        confidenceThreshold: 0.8,
        decidedAt: "2026-07-24T14:00:00.000Z",
      });

      upsertDiscoveredProduct(db, "retailer", {
        canonicalUrl: "https://mercado.test/outside",
        externalId: "outside",
        sourceCategory: "Alimentos",
      }, "2026-07-25T12:00:00.000Z");

      expect(db.prepare(`
        SELECT in_scope AS inScope, last_seen AS lastSeen
        FROM products WHERE id = 'outside'
      `).get()).toEqual({
        inScope: 0,
        lastSeen: "2026-07-25T12:00:00.000Z",
      });
    } finally {
      db.close();
    }
  });
});
