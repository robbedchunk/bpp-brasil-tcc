import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import type { ExtractionResult, ProductRef } from "../../src/strategies/types.js";
import type { ExtractionStrategy } from "../../src/strategies/schema.js";
import {
  attestStrategyValidationEvidence,
  evidenceValueSha256,
  strategyEvidenceSha256,
  validationRefSha256,
  validationSampleSetSha256,
  validateStrategyEvidence,
} from "../../src/strategies/validation-evidence.js";
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
const {
  privateKey: TEST_SIGNING_PRIVATE_KEY,
  publicKey: TEST_VERIFICATION_PUBLIC_KEY,
} = generateKeyPairSync("ed25519");

function resign(input: Record<string, unknown>) {
  const { attestation: _attestation, ...payload } = input;
  return attestStrategyValidationEvidence(payload, TEST_SIGNING_PRIVATE_KEY);
}

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
      success({ title: "9001" }),
      success({ title: "Produto aguardando observação descritiva" }),
      success({ title: "Produto" }),
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

describe("strategy validation evidence", () => {
  function receipt() {
    const authoritativeRefs = refs(30);
    const samples = authoritativeRefs.map((ref, index) => {
      const request = {
        method: "GET" as const,
        url: ref.canonicalUrl,
        bodySha256: null,
      };
      const outcome = index < 27
        ? { status: "valid" as const, fields: success().fields! }
        : {
            status: "invalid" as const,
            failure: {
              category: "missing-fields" as const,
              message: "missing price",
              responded: true,
              statusCode: 200,
            },
          };
      return {
        ordinal: index + 1,
        startedOffsetMs: index * 1_100,
        durationMs: 100 + index,
        ref,
        refSha256: validationRefSha256(ref),
        request,
        requestSha256: evidenceValueSha256(request),
        response: {
          finalUrl: ref.canonicalUrl,
          statusCode: 200,
          contentType: "application/json",
          bodyBytes: 100 + index,
          bodySha256: evidenceValueSha256({ response: index }),
        },
        outcome,
        outcomeSha256: evidenceValueSha256(outcome),
        validatedFacts: {
          returnedProductId: ref.externalId,
          catalogSellerId: null,
          catalogSellerMatchCount: null,
        },
      };
    });
    const elapsedMs = 29 * 1_100 + 129;
    const base = {
      schemaVersion: 2 as const,
      retailerId: "retailer",
      purpose: "extraction" as const,
      strategyVersion: 2,
      strategySha256: strategyEvidenceSha256(strategy),
      validatedAt: "2026-07-11T04:49:04.000Z",
      executor: {
        program: "scripts/validate-strategies.ts" as const,
        version: 1 as const,
        mode: "trusted-live-host" as const,
        runtime: "node-v24",
        sourceCommit: "a".repeat(40),
        playwrightVersion: "1.61.1",
        chromiumVersion: "Chromium 141.0.0.0",
        sequentialPacingMs: 1_100,
        timeoutMs: 15_000,
        maxBodyBytes: 2_000_000,
        startedAt: new Date(Date.parse("2026-07-11T04:49:04.000Z") - elapsedMs).toISOString(),
        finishedAt: "2026-07-11T04:49:04.000Z",
        elapsedMs,
        requestHeadersStored: false as const,
        responseBodiesStored: false as const,
      },
      attempted: 30,
      valid: 27,
      score: 0.9,
      activatable: true,
      samples,
    };
    return {
      evidence: attestStrategyValidationEvidence({
        ...base,
        sampleSetSha256: validationSampleSetSha256(samples),
      }, TEST_SIGNING_PRIVATE_KEY),
      authoritativeRefs,
    };
  }

  it("binds 30 authoritative samples and recomputes every execution hash", () => {
    const { evidence, authoritativeRefs } = receipt();

    expect(validateStrategyEvidence(evidence, {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toMatchObject({ attempted: 30, valid: 27, activatable: true });
    const samples = evidence.samples;
    expect(() => validateStrategyEvidence(resign({
      ...evidence,
      samples: [...samples.slice(0, -1), { ...samples[0]!, ordinal: 30 }],
    }), {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toThrow(/duplicate/iu);
    expect(() => validateStrategyEvidence(resign({ ...evidence, valid: 28 }), {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toThrow(/aggregate/iu);
  });

  it("rejects recomputed attacker references and tampered outcomes", () => {
    const { evidence, authoritativeRefs } = receipt();
    const first = evidence.samples[0]!;
    const attackerRef = {
      ...first.ref,
      canonicalUrl: "https://shop.test/products/attacker",
      externalId: "attacker-id",
    };
    const attackerSample = {
      ...first,
      ref: attackerRef,
      refSha256: validationRefSha256(attackerRef),
      validatedFacts: {
        ...first.validatedFacts,
        returnedProductId: "attacker-id",
      },
    };
    const attackerSamples = [attackerSample, ...evidence.samples.slice(1)];
    expect(() => validateStrategyEvidence(resign({
      ...evidence,
      samples: attackerSamples,
      sampleSetSha256: validationSampleSetSha256(attackerSamples),
    }), {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toThrow(/authoritative/iu);

    expect(() => validateStrategyEvidence(resign({
      ...evidence,
      samples: [{
        ...first,
        outcome: { ...first.outcome, fields: success({ price: 999 }).fields! },
      }, ...evidence.samples.slice(1)],
    }), {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toThrow(/outcome hash/iu);
  });

  it("records non-responded failures without inventing response or product facts", () => {
    const { evidence, authoritativeRefs } = receipt();
    const first = evidence.samples[0]!;
    const outcome = {
      status: "invalid" as const,
      failure: {
        category: "network" as const,
        message: "connection reset",
        responded: false,
        statusCode: null,
      },
    };
    const replacement = {
      ...first,
      response: null,
      outcome,
      outcomeSha256: evidenceValueSha256(outcome),
      validatedFacts: {
        returnedProductId: null,
        catalogSellerId: null,
        catalogSellerMatchCount: null,
      },
    };
    const samples = [replacement, ...evidence.samples.slice(1)];
    const nonResponded = resign({
      ...evidence,
      valid: 26,
      score: 26 / 30,
      activatable: false,
      samples,
      sampleSetSha256: validationSampleSetSha256(samples),
    });

    expect(validateStrategyEvidence(nonResponded, {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toMatchObject({ valid: 26, activatable: false });
    const contradictoryOutcome = {
      ...outcome,
      failure: { ...outcome.failure, responded: true },
    };
    const contradictorySamples = [{
      ...replacement,
      outcome: contradictoryOutcome,
      outcomeSha256: evidenceValueSha256(contradictoryOutcome),
    }, ...evidence.samples.slice(1)];
    expect(() => validateStrategyEvidence(resign({
      ...nonResponded,
      samples: contradictorySamples,
      sampleSetSha256: validationSampleSetSha256(contradictorySamples),
    }), {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toThrow(/responded flag/iu);
  });

  it("rejects fabricated attestations, pacing claims, and secret-bearing URLs", () => {
    const { evidence, authoritativeRefs } = receipt();
    const { attestation: _attestation, ...payload } = evidence;
    const attackerSigned = attestStrategyValidationEvidence(
      payload,
      generateKeyPairSync("ed25519").privateKey,
    );
    expect(() => validateStrategyEvidence(attackerSigned, {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toThrow(/attestation/iu);

    const rushedSamples = evidence.samples.map((sample, index) => ({
      ...sample,
      startedOffsetMs: index * 100,
    }));
    expect(() => validateStrategyEvidence(resign({
      ...evidence,
      samples: rushedSamples,
      sampleSetSha256: validationSampleSetSha256(rushedSamples),
    }), {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toThrow(/pacing/iu);

    const first = evidence.samples[0]!;
    const secretUrl = `${first.request.url}?access_token=opaque-secret`;
    const request = { ...first.request, url: secretUrl };
    const secretSamples = [{
      ...first,
      request,
      requestSha256: evidenceValueSha256(request),
      response: { ...first.response!, finalUrl: secretUrl },
    }, ...evidence.samples.slice(1)];
    expect(() => validateStrategyEvidence(resign({
      ...evidence,
      samples: secretSamples,
      sampleSetSha256: validationSampleSetSha256(secretSamples),
    }), {
      retailerId: "retailer",
      purpose: "extraction",
      strategyVersion: 2,
      strategy,
      verificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      authoritativeRefs,
    })).toThrow(/allowlist/iu);
  });
});
