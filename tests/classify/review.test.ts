import { readFile } from "node:fs/promises";

import type Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLASSIFICATION_REVIEW_HEADERS,
  buildClassificationReviewTemplate,
  evaluateClassificationReview,
  validateClassificationReviewResult,
} from "../../src/classify/review.js";
import { openDatabase } from "../../src/db/database.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(count = 240, version = 3): Database.Database {
  const database = openDatabase(":memory:");
  databases.push(database);
  const item = database.prepare(`
    INSERT INTO ipca_items(id, code, name, weight, weight_period, source_url, citation)
    VALUES (?, ?, ?, 1, '2026-01', 'https://example.test/ipca', 'review fixture')
  `);
  for (let index = 0; index < 3; index += 1) {
    item.run(`item-${index}`, `110000${index}`, `Item ${index}`);
  }
  const retailer = database.prepare(`
    INSERT INTO retailers(id, name, base_url, cep, domains_json)
    VALUES (?, ?, ?, '01310100', ?)
  `);
  for (let index = 0; index < 4; index += 1) {
    retailer.run(`retailer-${index}`, `Retailer ${index}`, `https://retailer-${index}.example.test`, JSON.stringify([`retailer-${index}.example.test`]));
  }
  const product = database.prepare(`
    INSERT INTO products(id, retailer_id, canonical_url, title, brand, source_category, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, '2026-07-01', '2026-07-11')
  `);
  const classification = database.prepare(`
    INSERT INTO classifications(
      id, product_id, ipca_item_id, version, decision, confidence, method,
      prompt_version, model, input_json, output_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'llm', 'review-prompt-v1', 'review-model', ?, '{}', ?)
  `);
  for (let index = 0; index < count; index += 1) {
    const retailerId = `retailer-${index % 4}`;
    const productId = `product-${String(index).padStart(3, "0")}`;
    const title = index === 0 ? "=2+2" : `Public product ${index}`;
    // Coprime fixture cycles ensure every retailer has assigned and abstained
    // rows in every confidence band.
    const itemIndex = index % 11 === 0 ? null : index % 3;
    const itemId = itemIndex === null ? null : `item-${itemIndex}`;
    const decision = itemIndex === null ? "unclassified" : `110000${itemIndex}`;
    const confidence = [0.75, 0.85, 0.95][index % 3]!;
    product.run(
      productId,
      retailerId,
      `https://${retailerId}.example.test/product/${index}`,
      title,
      `Brand ${index % 5}`,
      `Category ${index % 7}`,
    );
    classification.run(
      `classification-${String(index).padStart(3, "0")}`,
      productId,
      itemId,
      version,
      decision,
      confidence,
      JSON.stringify({
        productId,
        title,
        brand: `Brand ${index % 5}`,
        sourceCategory: `Category ${index % 7}`,
        allowedItems: [],
      }),
      `2026-07-11T04:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    );
  }
  return database;
}

function reviewedCsv(
  csv: string,
  label: (row: string[], index: number) => string = (row) => row[14]!,
): string {
  const records = parse(csv, { columns: false, skip_empty_lines: true }) as string[][];
  const [headers, ...rows] = records;
  const reviewed = rows.map((row, index) => [...row.slice(0, 16), label(row, index)]);
  return `${[headers!, ...reviewed].map((row) => row.join(",")).join("\n")}\n`;
}

describe("classification human review evidence", () => {
  it("builds a stable exact-size stratified template bound to the classification frame", () => {
    const database = fixture();
    const options = { version: 3, sampledAt: "2026-07-11T05:00:00.000Z" };
    const first = buildClassificationReviewTemplate(database, options);
    const second = buildClassificationReviewTemplate(database, options);

    expect(first).toEqual(second);
    expect(first.sampleSize).toBe(200);
    expect(first.populationSize).toBe(240);
    expect(new Set(first.rows.map((row) => row.classificationId)).size).toBe(200);
    const strata = new Set(first.rows.map((row) => row.stratum));
    expect(strata.size).toBe(24);
    expect(new Set(first.rows.map((row) => row.retailerId))).toEqual(new Set([
      "retailer-0", "retailer-1", "retailer-2", "retailer-3",
    ]));
    expect(new Set(first.rows.map((row) => row.predictedLabel))).toEqual(new Set([
      "1100000", "1100001", "1100002", "unclassified",
    ]));
    expect(new Set([...strata].map((stratum) => stratum.match(/decision:([^|]+)/u)?.[1])))
      .toEqual(new Set(["assigned", "abstained"]));
    expect(new Set([...strata].map((stratum) => stratum.match(/confidence:([^|]+)/u)?.[1])))
      .toEqual(new Set(["below-0.80", "0.80-to-0.89", "0.90-plus"]));
    const retailerCounts = [0, 1, 2, 3].map((retailer) => first.rows
      .filter((row) => row.retailerId === `retailer-${retailer}`).length);
    expect(Math.min(...retailerCounts)).toBeGreaterThanOrEqual(45);
    expect(Math.max(...retailerCounts) - Math.min(...retailerCounts)).toBeLessThanOrEqual(10);
    expect(first.csv.split("\n")[0]).toBe(CLASSIFICATION_REVIEW_HEADERS.join(","));
    expect(first.csv).not.toContain("/product/");
    expect(first.csv).not.toContain("reviewer");
    if (first.rows.some((row) => row.title === "=2+2")) expect(first.csv).toContain("'=2+2");
    expect(first.rows.every((row) => row.retailerId !== "" && row.title !== "")).toBe(true);
  });

  it("strictly evaluates labels and recomputes overall and per-stratum precision", () => {
    const database = fixture();
    const template = buildClassificationReviewTemplate(database, {
      version: 3,
      sampledAt: "2026-07-11T05:00:00.000Z",
    });
    const csv = reviewedCsv(template.csv, (row, index) => {
      if (index >= 10) return row[14]!;
      return row[14] === "1100000" ? "1100001" : "1100000";
    });
    const result = evaluateClassificationReview(database, csv, {
      reviewerId: "opaque-review-session-01",
      reviewedAt: "2026-07-11T06:00:00.000Z",
      now: new Date("2026-07-11T06:00:01.000Z"),
    });

    expect(result).toMatchObject({
      status: "complete",
      classificationVersion: 3,
      populationSize: 240,
      sampleSize: 200,
    });
    expect(result.overall.reviewed).toBe(200);
    expect(result.overall.assigned).toBeGreaterThan(0);
    expect(result.overall.precision).toBeLessThan(1);
    expect(result.strata.reduce((sum, stratum) => sum + stratum.reviewed, 0)).toBe(200);
    expect(() => validateClassificationReviewResult(database, result, {
      now: new Date("2026-07-11T06:00:01.000Z"),
    })).not.toThrow();
    expect(JSON.stringify(result)).not.toContain("Public product");
    expect(JSON.stringify(result)).not.toContain("product-001");
  });

  it("rejects changed sample fields, incomplete input, unknown labels, and future review claims", () => {
    const database = fixture();
    const template = buildClassificationReviewTemplate(database, {
      version: 3,
      sampledAt: "2026-07-11T05:00:00.000Z",
    });
    const valid = reviewedCsv(template.csv);
    const changedTitle = valid.replace("Public product", "Changed product");
    expect(() => evaluateClassificationReview(database, changedTitle, {
      reviewerId: "opaque-review-session-01",
      reviewedAt: "2026-07-11T06:00:00.000Z",
    })).toThrow(/bound field/iu);
    const unknown = reviewedCsv(template.csv, () => "free text label");
    expect(() => evaluateClassificationReview(database, unknown, {
      reviewerId: "opaque-review-session-01",
      reviewedAt: "2026-07-11T06:00:00.000Z",
    })).toThrow(/unknown|label/iu);
    const lines = valid.trimEnd().split("\n");
    expect(() => evaluateClassificationReview(database, `${lines.slice(0, -1).join("\n")}\n`, {
      reviewerId: "opaque-review-session-01",
      reviewedAt: "2026-07-11T06:00:00.000Z",
    })).toThrow();
    expect(() => evaluateClassificationReview(database, valid, {
      reviewerId: "opaque-review-session-01",
      reviewedAt: "2026-07-12T06:00:00.000Z",
      now: new Date("2026-07-11T06:00:00.000Z"),
    })).toThrow(/time|window/iu);
  });

  it("rejects tampered public results even when their outer schema remains valid", () => {
    const database = fixture();
    const template = buildClassificationReviewTemplate(database, {
      version: 3,
      sampledAt: "2026-07-11T05:00:00.000Z",
    });
    const result = evaluateClassificationReview(database, reviewedCsv(template.csv), {
      reviewerId: "opaque-review-session-01",
      reviewedAt: "2026-07-11T06:00:00.000Z",
      now: new Date("2026-07-11T06:00:01.000Z"),
    });
    const options = { now: new Date("2026-07-11T06:00:01.000Z") };
    expect(() => validateClassificationReviewResult(database, {
      ...result,
      sampleSha256: "0".repeat(64),
    }, options)).toThrow(/sample/iu);
    expect(() => validateClassificationReviewResult(database, {
      ...result,
      overall: { ...result.overall, precision: 0 },
    }, options)).toThrow(/metrics|hash/iu);
    const duplicate = structuredClone(result);
    duplicate.reviews[1] = duplicate.reviews[0]!;
    expect(() => validateClassificationReviewResult(database, duplicate, options))
      .toThrow(/duplicate|unknown/iu);
  });

  it("ships a standalone explicit export/evaluate script without production mutation commands", async () => {
    const [script, gitignore] = await Promise.all([
      readFile(new URL("../../scripts/classification-review.ts", import.meta.url), "utf8"),
      readFile(new URL("../../.gitignore", import.meta.url), "utf8"),
    ]);
    expect(script).toContain('"export" | "evaluate"');
    expect(script).toContain("readonly: true");
    expect(script).toContain("data/reviews/classification-review-v");
    expect(script).toContain("data/acceptance/evidence/classification-review-v");
    expect(script).not.toContain("INSERT INTO");
    expect(script).not.toContain("UPDATE ");
    expect(gitignore).toContain("data/reviews/*.csv");
  });
});
