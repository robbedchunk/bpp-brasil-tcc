import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  insertTestStrategyValidationEvidenceRow,
  openDatabase,
} from "../../src/db/database.js";
import {
  assertHealingSabotageReceiptFresh,
  healingSafetyTriggerSetSha256,
  runHealingSabotageDrill,
  signHealingSabotageDrillReceipt,
  validateHealingSabotageRetainedBindings,
  validateHealingSabotageDrillReceipt,
  type HealingSabotageDrillPayload,
} from "../../src/ops/healing-drill.js";
import { canonicalReleaseJson } from "../../src/ops/release-manifest.js";
import {
  loadRetailerConfigs,
  RetailerConfigSchema,
} from "../../src/retailers/config.js";
import { ApiExtractionStrategySchema } from "../../src/strategies/schema.js";
import { validationReceiptSha256 } from "../../src/strategies/validation-evidence.js";
import { signedCandidateReport } from "../helpers/validation-receipt.js";

const keys = generateKeyPairSync("ed25519");
const retainedDatabases: Database.Database[] = [];
const retainedRoots: string[] = [];

afterEach(async () => {
  for (const database of retainedDatabases.splice(0)) database.close();
  await Promise.all(retainedRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function payload(): HealingSabotageDrillPayload {
  return {
    schemaVersion: 1,
    drill: "installed-release-healing-sabotage",
    status: "pass",
    drillId: "1".repeat(32),
    observedAt: "2026-07-11T10:00:00.000Z",
    release: {
      releaseId: "2".repeat(32),
      sourceCommit: "3".repeat(40),
      manifestSha256: "4".repeat(64),
      artifactSetSha256: "5".repeat(64),
      implementationSha256: "6".repeat(64),
    },
    staging: {
      databaseRelativePath: `var/acceptance/m5-healing/${"1".repeat(32)}/staging.sqlite`,
      databaseSha256: "7".repeat(64),
      schemaVersion: 15,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      sourceSnapshotSha256Before: "8".repeat(64),
      sourceSnapshotSha256After: "8".repeat(64),
      sourceUnchanged: true,
      templateRetailerId: "extra-mercado",
      disposableRetailerId: `m5-drill-${"1".repeat(12)}`,
      configSha256: "9".repeat(64),
      sabotageKind: "staging-only-invalid-json-field-selectors",
      brokenStrategySha256: "a".repeat(64),
      restoredSafetyTriggerSetSha256: "b".repeat(64),
    },
    brokenRun: {
      id: "broken-run",
      strategyId: `m5-drill-${"1".repeat(12)}-extraction-v1`,
      strategyVersion: 1,
      attempted: 30,
      ok: 0,
      failed: 30,
      successRate: 0,
      status: "failed",
    },
    monitor: {
      health: "drift",
      action: "queued",
      healingEventId: "healing-event",
    },
    healing: {
      status: "recovered",
      attempts: 1,
      activated: true,
      explorationRunId: "exploration-run",
      successorStrategyId: `m5-drill-${"1".repeat(12)}-extraction-v2`,
      successorStrategyVersion: 2,
    },
    cost: {
      provider: "codex-sdk",
      model: "gpt-5.6-sol",
      reservationStatus: "settled",
      reservationAmountUsd: 5,
      actualCostUsd: 0.12,
      ledgerRows: 1,
      inputTokens: 1_000,
      outputTokens: 200,
    },
    validation: {
      receiptPath: `data/validation/m5-drill-${"1".repeat(12)}-extraction-v2.json`,
      receiptSha256: "c".repeat(64),
      sampleSetSha256: "d".repeat(64),
      attempted: 30,
      valid: 30,
      score: 1,
      executorMode: "trusted-live-host",
      validatorArtifactSha256: "e".repeat(64),
      challengeAlgorithm: "active-in-scope-category-url-bucket-round-robin-v1",
    },
    recoveredRun: {
      id: "recovered-run",
      strategyId: `m5-drill-${"1".repeat(12)}-extraction-v2`,
      strategyVersion: 2,
      attempted: 30,
      ok: 30,
      failed: 0,
      successRate: 1,
      status: "completed",
    },
  };
}

type RetainedCorruption =
  | "blocking-failures"
  | "event-binding"
  | "broken-strategy"
  | "runtime-config"
  | "restored-trigger"
  | "validation-row";

async function retainedBindingFixture(corruption?: RetainedCorruption) {
  const database = openDatabase(":memory:");
  retainedDatabases.push(database);
  const root = await mkdtemp(join(tmpdir(), "m5-retained-bindings-"));
  retainedRoots.push(root);
  const stagingDatabasePath = join(root, "staging.sqlite");
  const disposableRetailerId = `m5-drill-${"1".repeat(12)}`;
  const brokenStrategyId = `${disposableRetailerId}-extraction-v1`;
  const successorStrategyId = `${disposableRetailerId}-extraction-v2`;
  const template = loadRetailerConfigs(resolve("retailers"))
    .find(({ id }) => id === "extra-mercado");
  if (template === undefined) throw new Error("Missing retained-binding template config");
  const brokenStrategy = ApiExtractionStrategySchema.parse({
    ...template.extraction,
    fields: {
      title: "$.m5DeliberatelyBrokenSelector.title",
      brand: "$.m5DeliberatelyBrokenSelector.brand",
      price: "$.m5DeliberatelyBrokenSelector.price",
      promoPrice: "$.m5DeliberatelyBrokenSelector.promoPrice",
      unit: "$.m5DeliberatelyBrokenSelector.unit",
      availability: "$.m5DeliberatelyBrokenSelector.availability",
    },
  });
  const successorStrategy = ApiExtractionStrategySchema.parse(template.extraction);
  const strategyVersions = { ...template.strategyVersions, extraction: 1 };
  const config = RetailerConfigSchema.parse({
    ...template,
    id: disposableRetailerId,
    name: "M5 retained binding fixture",
    strategyVersions,
    extraction: brokenStrategy,
    validation: {
      discovery: {
        ...template.validation.discovery,
        receiptPath: `data/validation/${disposableRetailerId}-discovery-v${strategyVersions.discovery}.json`,
      },
      extraction: {
        ...template.validation.extraction,
        receiptPath: `data/validation/${disposableRetailerId}-extraction-v1.json`,
      },
    },
  });
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);

  database.prepare(`
    INSERT INTO retailers(id, name, base_url, cep, domains_json, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(
    disposableRetailerId,
    config.name,
    config.baseUrl,
    config.cep,
    JSON.stringify(config.allowedDomains),
  );
  database.prepare(`
    INSERT INTO strategies(
      id, retailer_id, purpose, tier, version, strategy_json, provenance,
      validation_sample_size, validation_successes, validation_rate, active,
      validated_at, retired_at
    ) VALUES (?, ?, 'extraction', 1, 1, ?, 'M5 retained fixture',
              0, 0, NULL, 0, NULL, '2026-07-11T10:02:00.000Z')
  `).run(
    brokenStrategyId,
    disposableRetailerId,
    JSON.stringify(corruption === "broken-strategy" ? successorStrategy : brokenStrategy),
  );

  const refs = Array.from({ length: 30 }, (_, index) => ({
    canonicalUrl: `https://www.extramercado.com.br/produto/m5-${index + 1}`,
    externalId: String(index + 1),
    sourceCategory: "M5 fixture",
  }));
  const report = signedCandidateReport(successorStrategy, refs, {
    retailerId: disposableRetailerId,
    purpose: "extraction",
    strategyVersion: 2,
  }, 1);
  if (report.receipt === undefined) throw new Error("Missing signed successor fixture");
  const successorEvidence = report.receipt.evidence;
  database.prepare(`
    INSERT INTO strategies(
      id, retailer_id, purpose, tier, version, strategy_json, provenance,
      validation_sample_size, validation_successes, validation_rate, active,
      validated_at
    ) VALUES (?, ?, 'extraction', 1, 2, ?, 'M5 retained successor',
              30, 30, 1, 0, ?)
  `).run(
    successorStrategyId,
    disposableRetailerId,
    JSON.stringify(successorStrategy),
    successorEvidence.validatedAt,
  );
  const successorReceiptSha256 = validationReceiptSha256(successorEvidence);
  insertTestStrategyValidationEvidenceRow(database, {
    strategy_id: successorStrategyId,
    receipt_path: report.receipt.path,
    receipt_sha256: corruption === "validation-row"
      ? "f".repeat(64)
      : successorReceiptSha256,
    sample_set_sha256: successorEvidence.sampleSetSha256,
    executor_json: JSON.stringify(successorEvidence.executor),
    attestation_key_id: successorEvidence.attestation.keyId,
    attempted: successorEvidence.attempted,
    valid: successorEvidence.valid,
    score: successorEvidence.score,
    validated_at: successorEvidence.validatedAt,
    recorded_at: successorEvidence.validatedAt,
  });
  database.prepare(`
    UPDATE strategies SET active = 1, activated_at = '2026-07-11T10:03:00.000Z'
    WHERE id = ?
  `).run(successorStrategyId);
  database.prepare(`
    INSERT INTO runs(
      id, retailer_id, stage, collection_day, strategy_id, strategy_version,
      status, attempted, ok, failed, started_at, finished_at, metadata_json
    ) VALUES ('broken-run', ?, 'collect', '2026-07-11', ?, 1,
              'running', 0, 0, 0, '2026-07-11T10:00:00.000Z',
              NULL, '{}')
  `).run(disposableRetailerId, brokenStrategyId);
  const insertFailure = database.prepare(`
    INSERT INTO run_failures(
      id, run_id, retailer_id, canonical_url, category, message, responded,
      attempt, strategy_id, strategy_version, occurred_at
    ) VALUES (?, 'broken-run', ?, ?, ?, 'M5 deliberate failure', 1,
              1, ?, 1, ?)
  `);
  for (let index = 0; index < 30; index += 1) {
    insertFailure.run(
      `failure-${index + 1}`,
      disposableRetailerId,
      refs[index]!.canonicalUrl,
      corruption === "blocking-failures" ? "captcha" : "missing-fields",
      brokenStrategyId,
      `2026-07-11T10:00:${String(index).padStart(2, "0")}.000Z`,
    );
  }
  database.prepare(`
    UPDATE runs SET status = 'failed', attempted = 30, failed = 30,
                    finished_at = '2026-07-11T10:01:00.000Z'
    WHERE id = 'broken-run'
  `).run();
  database.prepare(`
    INSERT INTO healing_events(
      id, retailer_id, purpose, onset_run_id, previous_strategy_id,
      successor_strategy_id, category, status, attempts, tier_from, tier_to,
      drift_started_at, detected_at, recovered_at, details_json
    ) VALUES ('healing-event', ?, 'extraction', 'broken-run', ?, ?, ?,
              'recovered', 1, 1, 1, '2026-07-11T10:00:00.000Z',
              '2026-07-11T10:01:00.000Z', '2026-07-11T10:03:00.000Z', '{}')
  `).run(
    disposableRetailerId,
    corruption === "event-binding" ? successorStrategyId : brokenStrategyId,
    successorStrategyId,
    corruption === "event-binding" ? "blocking" : "drift",
  );

  const runtimeConfigDirectory = join(root, "runtime", "retailers");
  await mkdir(runtimeConfigDirectory, { recursive: true, mode: 0o700 });
  const configPath = join(runtimeConfigDirectory, `${disposableRetailerId}.json`);
  await writeFile(
    configPath,
    corruption === "runtime-config" ? Buffer.concat([configBytes, Buffer.from(" ")]) : configBytes,
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  const restoredSafetyTriggerSetSha256 = healingSafetyTriggerSetSha256(database);
  if (corruption === "restored-trigger") {
    const triggerName = "strategies_active_validation_binding_no_update";
    const row = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(triggerName) as { sql: string };
    const altered = row.sql.replace("WHEN NEW.active = 1", "WHEN NEW.active = 0");
    if (altered === row.sql) throw new Error("Trigger fixture could not be altered");
    database.exec(`DROP TRIGGER ${triggerName}`);
    database.exec(altered);
  }

  const retainedPayload = payload();
  retainedPayload.release.sourceCommit = successorEvidence.executor.sourceCommit;
  retainedPayload.staging.configSha256 = createHash("sha256").update(configBytes).digest("hex");
  retainedPayload.staging.brokenStrategySha256 = createHash("sha256")
    .update(canonicalReleaseJson(brokenStrategy)).digest("hex");
  retainedPayload.staging.restoredSafetyTriggerSetSha256 = restoredSafetyTriggerSetSha256;
  retainedPayload.validation.receiptPath = report.receipt.path;
  retainedPayload.validation.receiptSha256 = successorReceiptSha256;
  retainedPayload.validation.sampleSetSha256 = successorEvidence.sampleSetSha256;
  retainedPayload.validation.valid = successorEvidence.valid;
  retainedPayload.validation.score = successorEvidence.score;
  retainedPayload.validation.validatorArtifactSha256 = successorEvidence.executor.artifactSha256!;
  const receipt = signHealingSabotageDrillReceipt(retainedPayload, keys.privateKey);
  return { database, receipt, stagingDatabasePath, successorEvidence };
}

describe("installed-release healing sabotage drill receipts", () => {
  it("strictly signs, verifies, and freshness-checks the public-safe receipt", () => {
    const receipt = signHealingSabotageDrillReceipt(payload(), keys.privateKey);

    expect(validateHealingSabotageDrillReceipt(receipt, keys.publicKey)).toEqual(receipt);
    expect(() => assertHealingSabotageReceiptFresh(
      receipt,
      new Date("2026-08-10T09:59:59.999Z"),
    )).not.toThrow();
    expect(() => assertHealingSabotageReceiptFresh(
      receipt,
      new Date("2026-08-10T10:00:00.001Z"),
    )).toThrow(/stale/iu);
  });

  it("rejects tampering, offline-provider claims, and contradictory recovery", () => {
    const receipt = signHealingSabotageDrillReceipt(payload(), keys.privateKey);
    const tampered = structuredClone(receipt);
    tampered.payload.cost.inputTokens += 1;
    expect(() => validateHealingSabotageDrillReceipt(tampered, keys.publicKey))
      .toThrow(/signature/iu);

    const offline = payload() as unknown as Record<string, unknown>;
    (offline.cost as Record<string, unknown>).provider = "fixture";
    expect(() => signHealingSabotageDrillReceipt(
      offline as unknown as HealingSabotageDrillPayload,
      keys.privateKey,
    )).toThrow();

    const contradictory = payload();
    contradictory.recoveredRun.strategyId = contradictory.brokenRun.strategyId;
    expect(() => signHealingSabotageDrillReceipt(contradictory, keys.privateKey)).toThrow();
  });

  it("refuses before release or staging work without both credential and spend authorization", async () => {
    const common = {
      projectRoot: "/does/not/exist",
      databasePath: "/does/not/exist/database.sqlite",
      releasePath: "/does/not/exist/release",
      publicKeyPath: "/does/not/exist/public.pem",
      privateKeyPath: "/does/not/exist/private.pem",
      confirmStagingSabotage: true,
      authorizedSpendUsd: 25,
    };
    await expect(runHealingSabotageDrill({
      ...common,
      env: {},
    })).rejects.toThrow(/LIVE_OPENAI=1/iu);
    await expect(runHealingSabotageDrill({
      ...common,
      env: { LIVE_OPENAI: "1" },
    })).rejects.toThrow(/credential/iu);
    await expect(runHealingSabotageDrill({
      ...common,
      authorizedSpendUsd: 0,
      env: { LIVE_OPENAI: "1", OPENAI_API_KEY: "private-test-placeholder" },
    })).rejects.toThrow(/authorize-live-spend/iu);
    await expect(runHealingSabotageDrill({
      ...common,
      authorizedSpendUsd: 25.01,
      env: { LIVE_OPENAI: "1", OPENAI_API_KEY: "private-test-placeholder" },
    })).rejects.toThrow(/at most 25/iu);
  });

});

describe("retained M5 sabotage evidence bindings", () => {
  it("accepts mutually bound drift, strategy, runtime, trigger, and validation evidence", async () => {
    const fixture = await retainedBindingFixture();

    expect(() => validateHealingSabotageRetainedBindings(fixture)).not.toThrow();
  });

  it.each([
    ["blocking-failures", /independently prove drift/iu],
    ["event-binding", /not bound to the broken drift strategy/iu],
    ["broken-strategy", /broken strategy differs/iu],
    ["runtime-config", /config differs/iu],
    ["restored-trigger", /safety triggers differ/iu],
    ["validation-row", /validation database row differs/iu],
  ] as const)("rejects adversarial retained evidence: %s", async (corruption, error) => {
    const fixture = await retainedBindingFixture(corruption);

    expect(() => validateHealingSabotageRetainedBindings(fixture)).toThrow(error);
  });
});
