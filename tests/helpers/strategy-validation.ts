import type Database from "better-sqlite3";

import {
  insertTestStrategyValidationEvidenceRow,
  type StrategyValidationEvidenceInsert,
} from "../../src/db/database.js";

export function trustedValidationExecutorJson(
  finishedAt: string,
  overrides: Record<string, unknown> = {},
): string {
  const startedAt = new Date(new Date(finishedAt).getTime() - 1_000).toISOString();
  return JSON.stringify({
    program: "scripts/validate-strategies.ts",
    version: 1,
    mode: "trusted-live-host",
    runtime: "node-v24.18.0",
    sourceCommit: "f".repeat(40),
    playwrightVersion: "1.61.1",
    chromiumVersion: "Google Chrome for Testing 149.0.7827.55",
    artifactSha256: "d".repeat(64),
    challengeAlgorithm: "active-in-scope-category-url-bucket-round-robin-v1",
    sequentialPacingMs: 500,
    timeoutMs: 15_000,
    maxBodyBytes: 2_000_000,
    startedAt,
    finishedAt,
    elapsedMs: 1_000,
    requestHeadersStored: false,
    responseBodiesStored: false,
    ...overrides,
  });
}

export function insertTrustedStrategyValidationEvidence(
  database: Database.Database,
  strategyId: string,
  options: {
    receiptSha256?: string;
    sampleSetSha256?: string;
    attestationKeyId?: string;
    executorJson?: string;
    recordedAt?: string;
  } = {},
): StrategyValidationEvidenceInsert {
  const strategy = database.prepare(`
    SELECT retailer_id, purpose, version, validation_sample_size,
           validation_successes, validation_rate, validated_at
    FROM strategies WHERE id = ?
  `).get(strategyId) as {
    retailer_id: string;
    purpose: "discovery" | "extraction";
    version: number;
    validation_sample_size: number;
    validation_successes: number;
    validation_rate: number | null;
    validated_at: string | null;
  } | undefined;
  if (
    strategy === undefined
    || strategy.validation_rate === null
    || strategy.validated_at === null
  ) {
    throw new Error(`Strategy ${strategyId} lacks fixture validation aggregates`);
  }

  const evidence: StrategyValidationEvidenceInsert = {
    strategy_id: strategyId,
    receipt_path: `data/validation/${strategy.retailer_id}-${strategy.purpose}-v${strategy.version}.json`,
    receipt_sha256: options.receiptSha256 ?? "a".repeat(64),
    sample_set_sha256: options.sampleSetSha256 ?? "b".repeat(64),
    executor_json: options.executorJson
      ?? trustedValidationExecutorJson(strategy.validated_at),
    attestation_key_id: options.attestationKeyId ?? "c".repeat(64),
    attempted: strategy.validation_sample_size,
    valid: strategy.validation_successes,
    score: strategy.validation_rate,
    validated_at: strategy.validated_at,
    recorded_at: options.recordedAt ?? strategy.validated_at,
  };
  insertTestStrategyValidationEvidenceRow(database, evidence);
  return evidence;
}
