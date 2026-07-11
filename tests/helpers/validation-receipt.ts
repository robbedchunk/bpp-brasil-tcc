import { generateKeyPairSync } from "node:crypto";

import type {
  CandidateValidationContext,
  CandidateValidationReport,
} from "../../src/explorer/explore.js";
import type { Strategy } from "../../src/strategies/schema.js";
import type { ProductRef } from "../../src/strategies/types.js";
import {
  attestStrategyValidationEvidence,
  evidenceValueSha256,
  strategyEvidenceSha256,
  validationReceiptSha256,
  validationRefSha256,
  validationSampleSetSha256,
} from "../../src/strategies/validation-evidence.js";

const TEST_VALIDATION_KEYS = generateKeyPairSync("ed25519");

export function signedCandidateReport(
  strategy: Strategy,
  refs: readonly ProductRef[],
  context: CandidateValidationContext,
  score: number,
): CandidateValidationReport {
  const valid = Math.round(score * 30);
  const regionalSellerId = strategy.purpose === "extraction"
    && strategy.tier === "api"
    ? strategy.regionalContext?.catalogSellerId ?? null
    : null;
  const samples = refs.slice(0, 30).map((ref, index) => {
    const request = { method: "GET" as const, url: ref.canonicalUrl, bodySha256: null };
    const outcome = index < valid
      ? {
          status: "valid" as const,
          fields: context.purpose === "extraction"
            ? {
                title: `Product ${index}`,
                brand: "Fixture",
                price: 10,
                promoPrice: null,
                unit: "1 kg",
                available: true,
              }
            : null,
        }
      : {
          status: "invalid" as const,
          failure: {
            category: "missing-fields" as const,
            message: "fixture missing field",
            responded: true,
            statusCode: 200,
          },
        };
    return {
      ordinal: index + 1,
      startedOffsetMs: index * 500,
      durationMs: 50,
      ref,
      refSha256: validationRefSha256(ref),
      request,
      requestSha256: evidenceValueSha256(request),
      response: {
        finalUrl: ref.canonicalUrl,
        statusCode: 200,
        contentType: context.purpose === "extraction" ? "text/html" : "application/json",
        bodyBytes: 100,
        bodySha256: evidenceValueSha256({ index }),
      },
      outcome,
      outcomeSha256: evidenceValueSha256(outcome),
      validatedFacts: {
        returnedProductId: context.purpose === "extraction" ? ref.externalId : null,
        catalogSellerId: regionalSellerId,
        catalogSellerMatchCount: regionalSellerId === null ? null : 1,
      },
    };
  });
  const elapsedMs = 29 * 500 + 50;
  const validatedAt = "2026-07-10T00:10:00.000Z";
  const evidence = attestStrategyValidationEvidence({
    schemaVersion: 2,
    retailerId: context.retailerId,
    purpose: context.purpose,
    strategyVersion: context.strategyVersion,
    strategySha256: strategyEvidenceSha256(strategy),
    validatedAt,
    executor: {
      program: "scripts/validate-strategies.ts",
      version: 1,
      mode: "trusted-live-host",
      runtime: "node-v24.18.0",
      sourceCommit: "a".repeat(40),
      playwrightVersion: "1.61.1",
      chromiumVersion: "Chromium fixture",
      artifactSha256: "d".repeat(64),
      challengeAlgorithm: "active-in-scope-category-url-bucket-round-robin-v1",
      sequentialPacingMs: 500,
      timeoutMs: 15_000,
      maxBodyBytes: 2_000_000,
      startedAt: new Date(Date.parse(validatedAt) - elapsedMs).toISOString(),
      finishedAt: validatedAt,
      elapsedMs,
      requestHeadersStored: false,
      responseBodiesStored: false,
    },
    attempted: 30,
    valid,
    score,
    activatable: score >= 0.9,
    sampleSetSha256: validationSampleSetSha256(samples),
    samples,
  }, TEST_VALIDATION_KEYS.privateKey);
  return {
    attempted: 30,
    valid,
    score,
    activatable: score >= 0.9,
    ...(score >= 0.9
      ? {
          receipt: {
            path: `data/validation/${context.retailerId}-${context.purpose}-v${context.strategyVersion}.json`,
            sha256: validationReceiptSha256(evidence),
            evidence,
            testVerificationPublicKey: TEST_VALIDATION_KEYS.publicKey,
          },
        }
      : {}),
  };
}
