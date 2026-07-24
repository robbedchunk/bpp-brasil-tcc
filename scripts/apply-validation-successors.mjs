#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";

import {
  OVERLAY_PATH,
  PLAN_PATH,
  PUBLIC_KEY_PATH,
  RECOVERY_PLAN_PATH,
  SUCCESSOR_TOOL_PATHS,
  VALIDATOR_DIGEST_PATH,
  assertProjectRoot,
  assertTrackedUnmodified,
  assertTrustedImplementationClean,
  applyRecoveryConfigPatch,
  canonicalJson,
  formattedJson,
  git,
  inspectPlannedConfigs,
  inspectRecoveryConfigs,
  parseRecoveryPlan,
  parseSuccessorPlan,
  readJsonFile,
  recoveryOverlayPath,
  sha256,
  verifyCleanBuild,
  verifyCommittedPlan,
  verifyCommittedRecoveryPlan,
  verifyOverlay,
  verifyRecoveryFailedAttemptFiles,
  writeConfigBatchAtomically,
} from "./successor-tooling.mjs";

const CHALLENGE_ALGORITHM = "active-in-scope-category-url-bucket-round-robin-v1";

export function parseArguments(arguments_) {
  const options = {
    root: resolve(fileURLToPath(new URL("..", import.meta.url))),
    database: undefined,
    allowPartial: false,
    recovery: false,
  };
  for (let index = 0; index < arguments_.length;) {
    const name = arguments_[index];
    if (name === "--allow-partial") {
      options.allowPartial = true;
      index += 1;
      continue;
    }
    if (name === "--recovery") {
      options.recovery = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(
        "Usage: node scripts/apply-validation-successors.mjs [--root <path>] "
        + "[--database <path>] [--allow-partial] [--recovery]",
      );
    }
    if (name === "--root") options.root = resolve(value);
    else if (name === "--database") options.database = value;
    else throw new Error(`Unknown argument ${name}`);
    index += 2;
  }
  options.root = assertProjectRoot(options.root);
  options.database = resolve(options.root, options.database ?? "data/precos.sqlite");
  return options;
}

function assertRegularFile(path, label) {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symbolic-link file`);
  }
}

function activeStrategy(database, plan, strategy, configState, evidence, evidenceTools) {
  const rows = database.prepare(`
    SELECT strategy.id, strategy.version, strategy.strategy_json AS strategyJson,
           strategy.active, strategy.retired_at AS retiredAt
    FROM strategies AS strategy
    JOIN retailers AS retailer ON retailer.id = strategy.retailer_id
    WHERE strategy.retailer_id = ? AND strategy.purpose = ?
      AND strategy.active = 1 AND retailer.active = 1
  `).all(plan.retailerId, plan.purpose);
  if (rows.length !== 1) {
    throw new Error(`${plan.retailerId}/${plan.purpose} must have exactly one active DB strategy`);
  }
  const row = rows[0];
  const targetId = `${plan.retailerId}-${plan.purpose}-v${plan.toVersion}`;
  const target = database.prepare(`
    SELECT strategy_json AS strategyJson, active, validated_at AS validatedAt,
           validation_sample_size AS attempted, validation_successes AS valid,
           validation_rate AS score, activated_at AS activatedAt, retired_at AS retiredAt
    FROM strategies WHERE id = ?
  `).get(targetId);
  const targetEvidence = database.prepare(
    "SELECT 1 FROM strategy_validation_evidence WHERE strategy_id = ?",
  ).get(targetId);
  // A trusted generated activation may use an opaque immutable strategy ID.
  // Version, retailer, purpose, and strategy bytes are the lifecycle identity;
  // requiring a config-style ID here would strand that valid active row when
  // the validator trust anchor rotates.
  if (row.version === plan.fromVersion) {
    if (
      row.version !== plan.fromVersion
      || row.strategyJson !== JSON.stringify(strategy)
      || row.active !== 1
      || row.retiredAt !== null
      || (target !== undefined && (
        target.strategyJson !== JSON.stringify(strategy)
        || target.active !== 0
        || target.validatedAt !== null
        || target.attempted !== 0
        || target.valid !== 0
        || target.score !== null
        || target.activatedAt !== null
        || target.retiredAt !== null
        || targetEvidence !== undefined
      ))
    ) {
      throw new Error(`${plan.retailerId}/${plan.purpose} pending DB strategy differs from the plan`);
    }
    return "pending";
  }
  if (configState !== "applied" || row.id !== targetId || target === undefined) {
    throw new Error(`${plan.retailerId}/${plan.purpose} active DB strategy differs from the plan`);
  }
  const immutable = database.prepare(`
    SELECT receipt_path AS receiptPath, receipt_sha256 AS receiptSha256,
           sample_set_sha256 AS sampleSetSha256, executor_json AS executorJson,
           attestation_key_id AS keyId, attempted, valid, score,
           validated_at AS validatedAt
    FROM strategy_validation_evidence WHERE strategy_id = ?
  `).get(targetId);
  const predecessors = database.prepare(`
    SELECT strategy_json AS strategyJson, active, retired_at AS retiredAt
    FROM strategies
    WHERE retailer_id = ? AND purpose = ? AND version = ?
  `).all(plan.retailerId, plan.purpose, plan.fromVersion);
  const predecessor = predecessors.length === 1 ? predecessors[0] : undefined;
  if (
    target.strategyJson !== JSON.stringify(strategy)
    || target.active !== 1
    || target.validatedAt !== evidence.validatedAt
    || target.attempted !== evidence.attempted
    || target.valid !== evidence.valid
    || target.score !== evidence.score
    || target.activatedAt === null
    || target.retiredAt !== null
    || predecessor === undefined
    || predecessor.strategyJson !== JSON.stringify(strategy)
    || predecessor.active !== 0
    || predecessor.retiredAt === null
    || immutable === undefined
    || canonicalJson(immutable) !== canonicalJson({
      receiptPath: `data/validation/${plan.retailerId}-${plan.purpose}-v${plan.toVersion}.json`,
      receiptSha256: evidenceTools.validationReceiptSha256(evidence),
      sampleSetSha256: evidence.sampleSetSha256,
      executorJson: JSON.stringify(evidence.executor),
      keyId: evidence.attestation.keyId,
      attempted: evidence.attempted,
      valid: evidence.valid,
      score: evidence.score,
      validatedAt: evidence.validatedAt,
    })
  ) {
    throw new Error(`${plan.retailerId}/${plan.purpose} active successor lacks exact evidence`);
  }
  return "active";
}

function assertDatabaseHealthy(database) {
  database.pragma("query_only = ON");
  const integrity = database.pragma("integrity_check");
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("Authoritative database integrity_check failed");
  }
  const foreignKeys = database.pragma("foreign_key_check");
  if (foreignKeys.length !== 0) throw new Error("Authoritative database foreign_key_check failed");
}

function receiptPath(root, plan) {
  return resolve(
    root,
    `data/validation/${plan.retailerId}-${plan.purpose}-v${plan.toVersion}.json`,
  );
}

function failedReceiptPath(root, plan) {
  return resolve(
    root,
    `data/validation/attempts/${plan.retailerId}-${plan.purpose}-v${plan.toVersion}.json`,
  );
}

function assertReceiptContained(root, path) {
  const parent = resolve(root, "data/validation");
  const candidate = resolve(path);
  const child = relative(parent, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || dirname(candidate) !== parent) {
    throw new Error("Validation receipt escaped its canonical directory");
  }
  if (realpathSync(parent) !== parent || realpathSync(candidate) !== candidate) {
    throw new Error("Validation receipt path cannot traverse symbolic links");
  }
  assertRegularFile(candidate, `validation receipt ${basename(candidate)}`);
}

function assertFailedReceiptContained(root, path) {
  const parent = resolve(root, "data/validation/attempts");
  const candidate = resolve(path);
  const child = relative(parent, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || dirname(candidate) !== parent) {
    throw new Error("Failed validation receipt escaped its canonical directory");
  }
  if (realpathSync(parent) !== parent || realpathSync(candidate) !== candidate) {
    throw new Error("Failed validation receipt path cannot traverse symbolic links");
  }
  assertRegularFile(candidate, `failed validation receipt ${basename(candidate)}`);
}

function comparePublicKeys(trackedPublicKey, evidence) {
  if (evidence.attestation.keyId === undefined) {
    throw new Error("Validation receipt lacks an attestation key identity");
  }
  const der = trackedPublicKey.export({ type: "spki", format: "der" });
  if (sha256(der) !== evidence.attestation.keyId) {
    throw new Error("Validation receipt is not signed by the tracked public key");
  }
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function assertFailedAttemptRegistered(root, path, evidence, evidenceTools, sourceCommit) {
  const manifestPath = resolve(root, "data/validation/attempts/manifest.json");
  assertRegularFile(manifestPath, "failed-attempt manifest");
  if (realpathSync(manifestPath) !== manifestPath) {
    throw new Error("Failed-attempt manifest path cannot traverse symbolic links");
  }
  const manifest = readJsonFile(manifestPath, "failed-attempt manifest");
  if (!exactKeys(manifest, ["schemaVersion", "attempts"])
    || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.attempts)) {
    throw new Error("Failed-attempt manifest is malformed");
  }
  const relativePath = relative(root, path).split(sep).join("/");
  const entries = manifest.attempts.map((entry) => {
    if (!exactKeys(entry, ["fileSha256", "path", "receiptSha256", "strategySourceCommit"])
      || typeof entry.path !== "string"
      || !/^data\/validation\/attempts\/[a-z0-9-]+\.json$/u.test(entry.path)
      || typeof entry.fileSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.fileSha256)
      || typeof entry.receiptSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.receiptSha256)
      || typeof entry.strategySourceCommit !== "string"
      || !/^[a-f0-9]{40}$/u.test(entry.strategySourceCommit)) {
      throw new Error("Failed-attempt manifest contains a malformed entry");
    }
    return entry;
  });
  if (new Set(entries.map(({ path: entryPath }) => entryPath)).size !== entries.length) {
    throw new Error("Failed-attempt manifest contains duplicate paths");
  }
  const actualFiles = readdirSync(dirname(manifestPath))
    .filter((name) => name !== "manifest.json" && name.endsWith(".json"))
    .map((name) => `data/validation/attempts/${name}`)
    .sort();
  if (canonicalJson(actualFiles) !== canonicalJson(entries.map(({ path: entryPath }) => entryPath).sort())) {
    throw new Error("Failed-attempt manifest does not cover the exact preserved receipt set");
  }
  const entry = entries.find(({ path: entryPath }) => entryPath === relativePath);
  const expected = {
    path: relativePath,
    fileSha256: sha256(readFileSync(path)),
    receiptSha256: evidenceTools.validationReceiptSha256(evidence),
    strategySourceCommit: sourceCommit,
  };
  if (entry === undefined || canonicalJson(entry) !== canonicalJson(expected)) {
    throw new Error("Failed validation receipt is not exactly preserved in its manifest");
  }
}

export function validatePlannedReceipt(input) {
  const path = input.outcome === "success"
    ? receiptPath(input.root, input.plan)
    : failedReceiptPath(input.root, input.plan);
  if (input.outcome === "success") assertReceiptContained(input.root, path);
  else assertFailedReceiptContained(input.root, path);
  const evidence = input.evidenceTools.validateStrategyEvidence(
    JSON.parse(readFileSync(path, "utf8")),
    {
      retailerId: input.plan.retailerId,
      purpose: input.plan.purpose,
      strategyVersion: input.plan.toVersion,
      strategy: input.strategy,
      verificationPublicKey: input.trackedPublicKey,
      authoritativeRefs: input.authoritativeRefs ?? input.challenge,
    },
  );
  comparePublicKeys(input.trackedPublicKey, evidence);
  const expectedOutcome = input.outcome === "success"
    ? evidence.valid >= 27 && evidence.activatable === true
    : evidence.valid < 27 && evidence.activatable === false;
  if (
    evidence.executor.mode !== "trusted-live-host"
    || evidence.executor.sourceCommit !== input.sourceCommit
    || evidence.executor.artifactSha256 !== input.expectedValidator
    || evidence.executor.challengeAlgorithm !== CHALLENGE_ALGORITHM
    || evidence.attempted !== 30
    || !expectedOutcome
    || (input.requireExactChallenge !== false
      && canonicalJson(evidence.samples.map(({ ref }) => ref)) !== canonicalJson(input.challenge))
  ) {
    throw new Error(
      `${input.plan.retailerId}/${input.plan.purpose} ${input.outcome} receipt `
      + "is not bound to the trusted rollout",
    );
  }
  if (Date.parse(evidence.validatedAt) > (input.now ?? Date.now())) {
    throw new Error(`${input.plan.retailerId}/${input.plan.purpose} receipt is future-dated`);
  }
  if (input.outcome === "failure") {
    assertFailedAttemptRegistered(
      input.root,
      path,
      evidence,
      input.evidenceTools,
      input.sourceCommit,
    );
  }
  return { path, evidence };
}

function appliedMetadata(plan, source, evidence, evidenceTools) {
  return {
    ...source,
    externallyValidated: true,
    validatedAt: evidence.validatedAt,
    sampleSize: evidence.attempted,
    successes: evidence.valid,
    score: evidence.score,
    receiptPath: `data/validation/${plan.retailerId}-${plan.purpose}-v${plan.toVersion}.json`,
    receiptSha256: evidenceTools.validationReceiptSha256(evidence),
  };
}

function validateBurnedRecoveryAttempts(
  root,
  recovery,
  evidenceTools,
  trackedPublicKey,
) {
  verifyRecoveryFailedAttemptFiles(root, recovery);
  for (const plan of recovery.plans) {
    const historical = JSON.parse(git(root, [
      "show",
      `${recovery.parent.sourceCommit}:retailers/${plan.retailerId}.json`,
    ]));
    const raw = JSON.parse(readFileSync(resolve(root, plan.failedAttemptPath), "utf8"));
    const evidence = evidenceTools.validateStrategyEvidence(raw, {
      retailerId: plan.retailerId,
      purpose: plan.purpose,
      strategyVersion: plan.failedVersion,
      strategy: historical[plan.purpose],
      verificationPublicKey: trackedPublicKey,
    });
    comparePublicKeys(trackedPublicKey, evidence);
    if (evidenceTools.validationReceiptSha256(evidence) !== plan.failedAttemptReceiptSha256
      || evidence.strategySha256 !== plan.failedStrategySha256
      || evidence.sampleSetSha256 !== plan.failedAttemptSampleSetSha256
      || evidence.executor.sourceCommit !== recovery.parent.sourceCommit
      || evidence.executor.artifactSha256 !== recovery.parent.validatorArtifactSha256
      || evidence.executor.challengeAlgorithm !== CHALLENGE_ALGORITHM
      || evidence.attempted !== 30 || evidence.valid >= 27 || evidence.activatable !== false) {
      throw new Error(`${plan.retailerId}/${plan.purpose} burned receipt signature is misbound`);
    }
  }
}

function recoveryDatabasePhase(database, plan, sourceStrategy, candidateStrategy) {
  const active = database.prepare(`
    SELECT strategy.id, strategy.strategy_json AS strategyJson
    FROM strategies AS strategy
    JOIN retailers AS retailer ON retailer.id = strategy.retailer_id
    WHERE strategy.retailer_id = ? AND strategy.purpose = ?
      AND strategy.active = 1 AND retailer.active = 1
  `).all(plan.retailerId, plan.purpose);
  if (active.length !== 1) {
    throw new Error(`${plan.retailerId}/${plan.purpose} must have one active recovery strategy`);
  }
  const sourceId = `${plan.retailerId}-${plan.purpose}-v${plan.activeVersion}`;
  const failedId = `${plan.retailerId}-${plan.purpose}-v${plan.failedVersion}`;
  const targetId = `${plan.retailerId}-${plan.purpose}-v${plan.toVersion}`;
  const failed = database.prepare(`
    SELECT active FROM strategies WHERE id = ?
  `).get(failedId);
  const failedEvidence = database.prepare(
    "SELECT 1 FROM strategy_validation_evidence WHERE strategy_id = ?",
  ).get(failedId);
  if (failed?.active === 1 || failedEvidence !== undefined) {
    throw new Error(`${failedId} is a burned version and cannot carry activation evidence`);
  }
  if (active[0].id === sourceId && active[0].strategyJson === JSON.stringify(sourceStrategy)) {
    const target = database.prepare(`
      SELECT strategy_json AS strategyJson, active, validated_at AS validatedAt
      FROM strategies WHERE id = ?
    `).get(targetId);
    const targetEvidence = database.prepare(
      "SELECT 1 FROM strategy_validation_evidence WHERE strategy_id = ?",
    ).get(targetId);
    if (target !== undefined && (target.strategyJson !== JSON.stringify(candidateStrategy)
      || target.active !== 0 || target.validatedAt !== null || targetEvidence !== undefined)) {
      throw new Error(`${targetId} is not a pristine recovery target`);
    }
    return "pending";
  }
  if (active[0].id === targetId && active[0].strategyJson === JSON.stringify(candidateStrategy)) {
    return "active";
  }
  throw new Error(`${plan.retailerId}/${plan.purpose} recovery DB lineage is invalid`);
}

function assertActiveRecoveryEvidence(database, plan, sourceStrategy, candidateStrategy, evidence, tools) {
  const sourceId = `${plan.retailerId}-${plan.purpose}-v${plan.activeVersion}`;
  const targetId = `${plan.retailerId}-${plan.purpose}-v${plan.toVersion}`;
  const source = database.prepare(`
    SELECT strategy_json AS strategyJson, active, retired_at AS retiredAt
    FROM strategies WHERE id = ?
  `).get(sourceId);
  const target = database.prepare(`
    SELECT strategy_json AS strategyJson, active, validation_sample_size AS attempted,
           validation_successes AS valid, validation_rate AS score,
           validated_at AS validatedAt, activated_at AS activatedAt, retired_at AS retiredAt
    FROM strategies WHERE id = ?
  `).get(targetId);
  const immutable = database.prepare(`
    SELECT receipt_path AS receiptPath, receipt_sha256 AS receiptSha256,
           sample_set_sha256 AS sampleSetSha256, executor_json AS executorJson,
           attestation_key_id AS keyId, attempted, valid, score,
           validated_at AS validatedAt
    FROM strategy_validation_evidence WHERE strategy_id = ?
  `).get(targetId);
  if (source === undefined || source.strategyJson !== JSON.stringify(sourceStrategy)
    || source.active !== 0 || source.retiredAt === null
    || target === undefined || target.strategyJson !== JSON.stringify(candidateStrategy)
    || target.active !== 1 || target.attempted !== evidence.attempted
    || target.valid !== evidence.valid || target.score !== evidence.score
    || target.validatedAt !== evidence.validatedAt || target.activatedAt === null
    || target.retiredAt !== null || immutable === undefined
    || canonicalJson(immutable) !== canonicalJson({
      receiptPath: `data/validation/${plan.retailerId}-${plan.purpose}-v${plan.toVersion}.json`,
      receiptSha256: tools.validationReceiptSha256(evidence),
      sampleSetSha256: evidence.sampleSetSha256,
      executorJson: JSON.stringify(evidence.executor),
      keyId: evidence.attestation.keyId,
      attempted: evidence.attempted,
      valid: evidence.valid,
      score: evidence.score,
      validatedAt: evidence.validatedAt,
    })) {
    throw new Error(`${targetId} lacks exact immutable recovery evidence`);
  }
}

function historicalRefs(database, retailerId) {
  return database.prepare(`
    SELECT canonical_url AS canonicalUrl, retailer_product_id AS externalId,
           source_category AS sourceCategory
    FROM products WHERE retailer_id = ? ORDER BY canonical_url
  `).all(retailerId);
}

async function applyValidationRecovery(options, root) {
  if (options.allowPartial === true) {
    throw new Error("Recovery mode is an atomic two-strategy operation; --allow-partial is forbidden");
  }
  const recovery = parseRecoveryPlan(
    readJsonFile(resolve(root, RECOVERY_PLAN_PATH), "successor recovery plan"),
  );
  const configs = inspectRecoveryConfigs(root, recovery, { allowApplied: true });
  assertTrackedUnmodified(root, [
    RECOVERY_PLAN_PATH,
    PUBLIC_KEY_PATH,
    VALIDATOR_DIGEST_PATH,
    ...SUCCESSOR_TOOL_PATHS,
    ...configs.map(({ path }) => path),
    ...recovery.plans.map(({ candidatePath, failedAttemptPath }) => [
      candidatePath,
      failedAttemptPath,
    ]).flat(),
    "data/validation/attempts/manifest.json",
  ]);
  const declaredBuild = readJsonFile(resolve(root, "dist/build-manifest.json"), "dist build manifest");
  if (typeof declaredBuild.sourceCommit !== "string"
    || !/^[a-f0-9]{40}$/u.test(declaredBuild.sourceCommit)) {
    throw new Error("dist build manifest source commit is malformed");
  }
  const sourceConfigs = configs.map((entry) => ({
    ...entry,
    config: JSON.parse(git(root, ["show", `${declaredBuild.sourceCommit}:${entry.path}`])),
    state: "pending",
  }));
  const sourceCommit = verifyCommittedRecoveryPlan(
    root,
    recovery,
    sourceConfigs,
    declaredBuild.sourceCommit,
  );
  verifyOverlay(root, sourceConfigs, recoveryOverlayPath(root, recovery));
  const build = verifyCleanBuild(root, sourceCommit);
  const publicKeyPath = resolve(root, PUBLIC_KEY_PATH);
  assertRegularFile(publicKeyPath, "tracked validation public key");
  if (realpathSync(publicKeyPath) !== publicKeyPath) {
    throw new Error("Tracked validation public key path cannot traverse symbolic links");
  }
  const trackedPublicKey = createPublicKey(readFileSync(publicKeyPath));
  if (trackedPublicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Tracked validation public key must be Ed25519");
  }
  const moduleUrl = (path) => {
    const url = pathToFileURL(resolve(build.dist, path));
    url.searchParams.set("sha256", sha256(readFileSync(fileURLToPath(url))));
    return url.href;
  };
  const [evidenceTools, challengeTools, configTools] = await Promise.all([
    import(moduleUrl("strategies/validation-evidence.js")),
    import(moduleUrl("strategies/validation-challenge.js")),
    import(moduleUrl("retailers/config.js")),
  ]);
  const keyDer = trackedPublicKey.export({ type: "spki", format: "der" });
  if (sha256(keyDer) !== recovery.parent.attestationKeyId) {
    throw new Error("Recovery parent attestation key differs from the tracked key");
  }
  validateBurnedRecoveryAttempts(root, recovery, evidenceTools, trackedPublicKey);
  const databasePath = resolve(options.database ?? resolve(root, "data/precos.sqlite"));
  assertRegularFile(databasePath, "authoritative database");
  if (realpathSync(databasePath) !== databasePath) {
    throw new Error("Authoritative database path cannot traverse symbolic links");
  }
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  const desiredByRetailer = new Map(sourceConfigs.map((entry) => [
    entry.retailerId,
    structuredClone(entry.config),
  ]));
  const currentExpectedByRetailer = new Map(sourceConfigs.map((entry) => [
    entry.retailerId,
    structuredClone(entry.config),
  ]));
  const applied = [];
  try {
    assertDatabaseHealthy(database);
    for (const entry of configs) {
      const plan = entry.plans[0];
      const source = sourceConfigs.find(({ retailerId }) => retailerId === entry.retailerId)?.config;
      if (plan === undefined || source === undefined) throw new Error("Recovery config lost its plan");
      const candidate = plan.candidateStrategy;
      const phase = recoveryDatabasePhase(
        database,
        plan,
        source[plan.purpose],
        candidate,
      );
      if (!existsSync(receiptPath(root, plan))) {
        throw new Error(`${plan.retailerId}/${plan.purpose} recovery receipt is missing`);
      }
      const exactChallenge = phase === "pending"
        ? challengeTools.selectStrategyValidationChallenge(database, plan.retailerId, 30)
        : null;
      const authoritativeRefs = phase === "active"
        ? historicalRefs(database, plan.retailerId)
        : exactChallenge;
      if (authoritativeRefs.length < 30) {
        throw new Error(`${plan.retailerId} lacks 30 authoritative recovery references`);
      }
      const { evidence } = validatePlannedReceipt({
        root,
        plan,
        strategy: candidate,
        challenge: exactChallenge ?? [],
        authoritativeRefs,
        requireExactChallenge: phase === "pending",
        trackedPublicKey,
        evidenceTools,
        sourceCommit,
        expectedValidator: build.expectedValidator,
        outcome: "success",
      });
      if (phase === "active") {
        assertActiveRecoveryEvidence(
          database,
          plan,
          source[plan.purpose],
          candidate,
          evidence,
          evidenceTools,
        );
      }
      const desired = desiredByRetailer.get(entry.retailerId);
      if (desired === undefined) throw new Error("Recovery desired config is missing");
      const patchedDesired = applyRecoveryConfigPatch(desired, plan);
      desiredByRetailer.set(entry.retailerId, patchedDesired);
      patchedDesired[plan.purpose] = structuredClone(candidate);
      patchedDesired.strategyVersions[plan.purpose] = plan.toVersion;
      patchedDesired.validation[plan.purpose] = appliedMetadata(
        plan,
        source.validation[plan.purpose],
        evidence,
        evidenceTools,
      );
      if (entry.state === "applied") {
        const expected = applyRecoveryConfigPatch(
          currentExpectedByRetailer.get(entry.retailerId),
          plan,
        );
        currentExpectedByRetailer.set(entry.retailerId, expected);
        expected[plan.purpose] = structuredClone(candidate);
        expected.strategyVersions[plan.purpose] = plan.toVersion;
        expected.validation[plan.purpose] = patchedDesired.validation[plan.purpose];
      }
      applied.push({
        retailerId: plan.retailerId,
        purpose: plan.purpose,
        activeVersion: plan.activeVersion,
        failedVersion: plan.failedVersion,
        toVersion: plan.toVersion,
        state: entry.state === "applied" ? "already-applied" : "newly-applied",
        receiptSha256: evidenceTools.validationReceiptSha256(evidence),
      });
    }
  } finally {
    database.close();
  }
  const updates = [];
  for (const entry of configs) {
    const expected = currentExpectedByRetailer.get(entry.retailerId);
    const desired = desiredByRetailer.get(entry.retailerId);
    configTools.RetailerConfigSchema.parse(desired);
    if (canonicalJson(entry.config) !== canonicalJson(expected)) {
      throw new Error(`${entry.retailerId} differs from exact recovery lifecycle state`);
    }
    const content = formattedJson(desired);
    const current = readFileSync(resolve(root, entry.path));
    if (sha256(current) !== sha256(content)) {
      updates.push({ path: entry.path, originalSha256: sha256(current), content });
    }
  }
  if (updates.length > 0) writeConfigBatchAtomically(root, updates);
  return {
    root,
    sourceCommit,
    receipts: applied,
    applied,
    skipped: [],
    configs: updates.map(({ path }) => path),
    allowPartial: false,
    recovery: true,
  };
}

export async function applyValidationSuccessors(options) {
  const root = assertProjectRoot(options.root);
  assertTrustedImplementationClean(root);
  if (options.recovery === true) return applyValidationRecovery(options, root);
  const allowPartial = options.allowPartial === true;
  const databasePath = resolve(options.database ?? resolve(root, "data/precos.sqlite"));
  const plans = parseSuccessorPlan(readJsonFile(resolve(root, PLAN_PATH), "successor plan"));
  const configs = inspectPlannedConfigs(root, plans, { allowApplied: allowPartial });
  assertTrackedUnmodified(root, [
    PLAN_PATH,
    PUBLIC_KEY_PATH,
    ...SUCCESSOR_TOOL_PATHS,
    VALIDATOR_DIGEST_PATH,
    ...configs.map(({ path }) => path),
  ]);
  const declaredBuild = readJsonFile(
    resolve(root, "dist/build-manifest.json"),
    "dist build manifest",
  );
  if (typeof declaredBuild.sourceCommit !== "string"
    || !/^[a-f0-9]{40}$/u.test(declaredBuild.sourceCommit)) {
    throw new Error("dist build manifest source commit is malformed");
  }
  const sourceConfigs = configs.map((entry) => ({
    ...entry,
    config: JSON.parse(git(root, ["show", `${declaredBuild.sourceCommit}:${entry.path}`])),
  }));
  const sourceCommit = verifyCommittedPlan(
    root,
    plans,
    sourceConfigs,
    declaredBuild.sourceCommit,
  );
  verifyOverlay(root, sourceConfigs, resolve(root, OVERLAY_PATH));
  const build = verifyCleanBuild(root, sourceCommit);
  const publicKeyPath = resolve(root, PUBLIC_KEY_PATH);
  assertRegularFile(publicKeyPath, "tracked validation public key");
  if (realpathSync(publicKeyPath) !== publicKeyPath) {
    throw new Error("Tracked validation public key path cannot traverse symbolic links");
  }
  const trackedPublicKey = createPublicKey(readFileSync(publicKeyPath));
  if (trackedPublicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Tracked validation public key must be Ed25519");
  }

  const evidenceModuleUrl = pathToFileURL(
    resolve(build.dist, "strategies/validation-evidence.js"),
  );
  evidenceModuleUrl.searchParams.set("sha256", sha256(readFileSync(fileURLToPath(evidenceModuleUrl))));
  const challengeModuleUrl = pathToFileURL(
    resolve(build.dist, "strategies/validation-challenge.js"),
  );
  challengeModuleUrl.searchParams.set("sha256", sha256(readFileSync(fileURLToPath(challengeModuleUrl))));
  const configModuleUrl = pathToFileURL(resolve(build.dist, "retailers/config.js"));
  configModuleUrl.searchParams.set("sha256", sha256(readFileSync(fileURLToPath(configModuleUrl))));
  const [evidenceTools, challengeTools, configTools] = await Promise.all([
    import(evidenceModuleUrl.href),
    import(challengeModuleUrl.href),
    import(configModuleUrl.href),
  ]);

  assertRegularFile(databasePath, "authoritative database");
  if (realpathSync(databasePath) !== databasePath) {
    throw new Error("Authoritative database path cannot traverse symbolic links");
  }
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  const sourceByRetailer = new Map(
    sourceConfigs.map((entry) => [entry.retailerId, structuredClone(entry.config)]),
  );
  const desiredByRetailer = new Map(
    sourceConfigs.map((entry) => [entry.retailerId, structuredClone(entry.config)]),
  );
  const currentExpectedByRetailer = new Map(
    sourceConfigs.map((entry) => [entry.retailerId, structuredClone(entry.config)]),
  );
  const applied = [];
  const skipped = [];
  try {
    assertDatabaseHealthy(database);
    for (const plan of plans) {
      const configEntry = configs.find(({ retailerId }) => retailerId === plan.retailerId);
      if (configEntry === undefined) throw new Error(`Missing config for ${plan.retailerId}`);
      const strategy = configEntry.config[plan.purpose];
      const configState = configEntry.config.strategyVersions[plan.purpose] === plan.toVersion
        ? "applied"
        : "pending";
      const challenge = challengeTools.selectStrategyValidationChallenge(
        database,
        plan.retailerId,
        30,
      );
      if (challenge.length !== 30) {
        throw new Error(`${plan.retailerId} has ${challenge.length}/30 authoritative references`);
      }
      const canonicalExists = existsSync(receiptPath(root, plan));
      if (!canonicalExists && !allowPartial) {
        throw new Error(
          `${plan.retailerId}/${plan.purpose} canonical activatable receipt is required; `
          + "use --allow-partial only with a preserved signed failed attempt",
        );
      }
      if (!canonicalExists && configState === "applied") {
        throw new Error(`${plan.retailerId}/${plan.purpose} applied config lacks its canonical receipt`);
      }
      const outcome = canonicalExists ? "success" : "failure";
      const { evidence } = validatePlannedReceipt({
        root,
        plan,
        strategy,
        challenge,
        trackedPublicKey,
        evidenceTools,
        sourceCommit,
        expectedValidator: build.expectedValidator,
        outcome,
      });
      activeStrategy(database, plan, strategy, configState, evidence, evidenceTools);
      if (outcome === "failure") {
        skipped.push({
          retailerId: plan.retailerId,
          purpose: plan.purpose,
          fromVersion: plan.fromVersion,
          toVersion: plan.toVersion,
          valid: evidence.valid,
          attempted: evidence.attempted,
          receiptSha256: evidenceTools.validationReceiptSha256(evidence),
        });
        continue;
      }
      const desired = desiredByRetailer.get(plan.retailerId);
      const source = sourceByRetailer.get(plan.retailerId);
      if (desired === undefined) throw new Error(`Missing desired config for ${plan.retailerId}`);
      if (source === undefined) throw new Error(`Missing source config for ${plan.retailerId}`);
      desired.strategyVersions[plan.purpose] = plan.toVersion;
      desired.validation[plan.purpose] = appliedMetadata(
        plan,
        source.validation[plan.purpose],
        evidence,
        evidenceTools,
      );
      if (configState === "applied") {
        const expected = currentExpectedByRetailer.get(plan.retailerId);
        if (expected === undefined) throw new Error(`Missing current config for ${plan.retailerId}`);
        expected.strategyVersions[plan.purpose] = plan.toVersion;
        expected.validation[plan.purpose] = appliedMetadata(
          plan,
          source.validation[plan.purpose],
          evidence,
          evidenceTools,
        );
      }
      applied.push({
        retailerId: plan.retailerId,
        purpose: plan.purpose,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        state: configState === "applied" ? "already-applied" : "newly-applied",
        valid: evidence.valid,
        attempted: evidence.attempted,
        receiptSha256: evidenceTools.validationReceiptSha256(evidence),
        sampleSetSha256: evidence.sampleSetSha256,
      });
    }
  } finally {
    database.close();
  }

  for (const configEntry of configs) {
    const retailerId = configEntry.retailerId;
    const desired = desiredByRetailer.get(retailerId);
    const currentExpected = currentExpectedByRetailer.get(retailerId);
    if (desired === undefined || currentExpected === undefined) {
      throw new Error(`Missing derived config for ${retailerId}`);
    }
    configTools.RetailerConfigSchema.parse(desired);
    configTools.RetailerConfigSchema.parse(currentExpected);
    if (canonicalJson(configEntry.config) !== canonicalJson(currentExpected)) {
      throw new Error(`${retailerId} config differs from exact applied receipt metadata`);
    }
    const overlayConfig = readJsonFile(
      resolve(root, OVERLAY_PATH, `${retailerId}.json`),
      `prepared overlay ${retailerId}`,
    );
    for (const purpose of applied
      .filter((entry) => entry.retailerId === retailerId)
      .map((entry) => entry.purpose)) {
      if (
        overlayConfig.strategyVersions[purpose] !== desired.strategyVersions[purpose]
        || canonicalJson(overlayConfig[purpose]) !== canonicalJson(desired[purpose])
      ) {
        throw new Error(`${retailerId}/${purpose} overlay strategy differs from signed evidence`);
      }
    }
  }

  const updates = configs.flatMap((entry) => {
    const desired = desiredByRetailer.get(entry.retailerId);
    const content = formattedJson(desired);
    const current = readFileSync(resolve(root, entry.path));
    return sha256(current) === sha256(content)
      ? []
      : [{ path: entry.path, originalSha256: sha256(current), content }];
  });
  if (updates.length > 0) writeConfigBatchAtomically(root, updates);
  return {
    root,
    sourceCommit,
    receipts: applied,
    applied,
    skipped,
    configs: updates.map(({ path }) => path),
    allowPartial,
    recovery: false,
  };
}

async function main() {
  const result = await applyValidationSuccessors(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    event: "validation-successors-applied",
    sourceCommit: result.sourceCommit,
    strategies: result.receipts.length,
    partialMode: result.allowPartial,
    recoveryMode: result.recovery,
    applied: result.applied,
    skipped: result.skipped,
    configs: result.configs,
    databaseMutation: false,
    activationPerformed: false,
  })}\n`);
}

function invokedAsMain(invoked) {
  if (invoked === undefined) return false;
  try {
    return realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
