import { describe, expect, it, vi } from "vitest";

import type { ExtractionResult, ProductRef } from "../../src/strategies/types.js";
import type { ExtractionStrategy } from "../../src/strategies/schema.js";
import { validateExtractionStrategy } from "../../src/strategies/validate.js";

const strategy = {
  schemaVersion: 1,
  purpose: "extraction",
  tier: "api",
  allowedDomains: ["shop.test"],
  request: { method: "GET", url: "{productUrl}", headers: {} },
  fields: {
    title: "$.name",
    brand: "$.brand",
    price: "$.price",
    promoPrice: "$.promo",
    unit: "$.unit",
    availability: "$.available",
  },
} as const satisfies ExtractionStrategy;

function refs(count: number): ProductRef[] {
  return Array.from({ length: count }, (_, index) => ({
    canonicalUrl: `https://shop.test/products/${index}`,
    externalId: String(index),
    sourceCategory: "grocery",
  }));
}

function success(overrides: Partial<NonNullable<ExtractionResult["fields"]>> = {}): ExtractionResult {
  return {
    ok: true,
    fields: {
      title: "Arroz Tipo 1",
      brand: "Marca",
      price: 12.99,
      promoPrice: 10.99,
      unit: "5 kg",
      available: true,
      ...overrides,
    },
  };
}

describe("validateExtractionStrategy", () => {
  it("activates exactly 30 samples at the inclusive 0.9 boundary", async () => {
    const execute = vi.fn(async (_strategy: ExtractionStrategy, ref: ProductRef) =>
      Number(ref.externalId) < 27
        ? success()
        : {
            ok: false,
            failure: {
              category: "missing-fields" as const,
              message: "missing title",
              responded: true,
            },
          },
    );

    const report = await validateExtractionStrategy(strategy, refs(30), execute);

    expect(report).toMatchObject({
      attempted: 30,
      valid: 27,
      score: 0.9,
      activatable: true,
    });
    expect(report.samples).toHaveLength(30);
    expect(execute).toHaveBeenCalledTimes(30);
  });

  it("reports 0.899 below the threshold without rounding it up", async () => {
    const report = await validateExtractionStrategy(
      strategy,
      refs(1_000),
      async (_strategy, ref) =>
        Number(ref.externalId) < 899
          ? success()
          : {
              ok: false,
              failure: {
                category: "missing-fields",
                message: "missing",
                responded: true,
              },
            },
      1_000,
    );

    expect(report).toMatchObject({
      attempted: 1_000,
      valid: 899,
      score: 0.899,
      activatable: false,
    });
  });

  it("de-duplicates canonical product URLs before sampling", async () => {
    const duplicate = refs(29);
    duplicate.push({ ...duplicate[0]! });
    const execute = vi.fn(async () => success());

    const report = await validateExtractionStrategy(strategy, duplicate, execute);

    expect(report).toMatchObject({
      attempted: 29,
      valid: 29,
      score: 1,
      activatable: false,
    });
    expect(execute).toHaveBeenCalledTimes(29);
  });

  it("validates every normalized extraction field invariant", async () => {
    const results: ExtractionResult[] = [
      success({ title: "   " }),
      success({ price: 0 }),
      success({ price: Number.NaN }),
      success({ promoPrice: 13 }),
      success({ promoPrice: 0 }),
      success({ brand: "" }),
      success({ unit: "   " }),
      {
        ok: true,
        fields: {
          ...success().fields!,
          available: "yes" as unknown as boolean,
        },
      },
    ];

    const report = await validateExtractionStrategy(
      strategy,
      refs(results.length),
      async (_strategy, ref) => results[Number(ref.externalId)]!,
      results.length,
    );

    expect(report.valid).toBe(0);
    expect(report.samples.every((sample) => sample.valid === false)).toBe(true);
    expect(report.samples.every((sample) => Boolean(sample.reason))).toBe(true);
  });

  it("turns executor failures and thrown errors into invalid samples", async () => {
    const report = await validateExtractionStrategy(
      strategy,
      refs(2),
      async (_strategy, ref) => {
        if (ref.externalId === "0") {
          throw new Error("request exploded");
        }
        return {
          ok: false,
          failure: {
            category: "timeout",
            message: "request timed out",
            responded: false,
          },
        };
      },
      2,
    );

    expect(report.valid).toBe(0);
    expect(report.samples[0]).toMatchObject({
      valid: false,
      reason: "request exploded",
    });
    expect(report.samples[1]).toMatchObject({
      valid: false,
      reason: "request timed out",
    });
  });

  it("does not trust an embedded agent score", async () => {
    const untrusted = { ...strategy, score: 1 } as ExtractionStrategy;
    const report = await validateExtractionStrategy(
      untrusted,
      refs(30),
      async () => ({
        ok: false,
        failure: {
          category: "parse",
          message: "invalid response",
          responded: true,
        },
      }),
    );

    expect(report).toMatchObject({ valid: 0, score: 0, activatable: false });
  });
});
