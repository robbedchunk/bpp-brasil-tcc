#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";

import {
  OVERLAY_PATH,
  PLAN_PATH,
  PUBLIC_KEY_PATH,
  SUCCESSOR_TOOL_PATHS,
  VALIDATOR_DIGEST_PATH,
  assertProjectRoot,
  assertTrackedUnmodified,
  assertTrustedImplementationClean,
  canonicalJson,
  formattedJson,
  inspectPlannedConfigs,
  parseSuccessorPlan,
  readJsonFile,
  sha256,
  verifyCleanBuild,
  verifyCommittedPlan,
  verifyOverlay,
  writeConfigBatchAtomically,
} from "./successor-tooling.mjs";

const CHALLENGE_ALGORITHM = "active-in-scope-category-url-bucket-round-robin-v1";

function parseArguments(arguments_) {
  const options = {
    root: resolve(fileURLToPath(new URL("..", import.meta.url))),
    database: undefined,
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(
        "Usage: node scripts/apply-validation-successors.mjs [--root <path>] [--database <path>]",
      );
    }
    if (name === "--root") options.root = resolve(value);
    else if (name === "--database") options.database = value;
    else throw new Error(`Unknown argument ${name}`);
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

function activeStrategy(database, plan, strategy) {
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
  if (
    row.id !== `${plan.retailerId}-${plan.purpose}-v${plan.fromVersion}`
    || row.version !== plan.fromVersion
    || row.strategyJson !== JSON.stringify(strategy)
    || row.active !== 1
    || row.retiredAt !== null
  ) {
    throw new Error(`${plan.retailerId}/${plan.purpose} active DB strategy differs from the plan`);
  }
  const target = database.prepare(`
    SELECT strategy_json AS strategyJson, active, validated_at AS validatedAt
    FROM strategies WHERE id = ?
  `).get(`${plan.retailerId}-${plan.purpose}-v${plan.toVersion}`);
  if (target !== undefined && (
    target.strategyJson !== JSON.stringify(strategy)
    || target.active !== 0
    || target.validatedAt !== null
  )) {
    throw new Error(`${plan.retailerId}/${plan.purpose} target DB identity is not pristine`);
  }
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

function comparePublicKeys(trackedPublicKey, evidence) {
  if (evidence.attestation.keyId === undefined) {
    throw new Error("Validation receipt lacks an attestation key identity");
  }
  const der = trackedPublicKey.export({ type: "spki", format: "der" });
  if (sha256(der) !== evidence.attestation.keyId) {
    throw new Error("Validation receipt is not signed by the tracked public key");
  }
}

export async function applyValidationSuccessors(options) {
  const root = assertProjectRoot(options.root);
  assertTrustedImplementationClean(root);
  const databasePath = resolve(options.database ?? resolve(root, "data/precos.sqlite"));
  const plans = parseSuccessorPlan(readJsonFile(resolve(root, PLAN_PATH), "successor plan"));
  const configs = inspectPlannedConfigs(root, plans);
  assertTrackedUnmodified(root, [
    PLAN_PATH,
    PUBLIC_KEY_PATH,
    ...SUCCESSOR_TOOL_PATHS,
    VALIDATOR_DIGEST_PATH,
    ...configs.map(({ path }) => path),
  ]);
  verifyOverlay(root, configs, resolve(root, OVERLAY_PATH));
  const declaredBuild = readJsonFile(
    resolve(root, "dist/build-manifest.json"),
    "dist build manifest",
  );
  const sourceCommit = verifyCommittedPlan(
    root,
    plans,
    configs,
    declaredBuild.sourceCommit,
  );
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
  const desiredByRetailer = new Map(
    configs.map((entry) => [entry.retailerId, structuredClone(entry.config)]),
  );
  const receipts = [];
  try {
    assertDatabaseHealthy(database);
    for (const plan of plans) {
      const configEntry = configs.find(({ retailerId }) => retailerId === plan.retailerId);
      if (configEntry === undefined) throw new Error(`Missing config for ${plan.retailerId}`);
      const strategy = configEntry.config[plan.purpose];
      activeStrategy(database, plan, strategy);
      const challenge = challengeTools.selectStrategyValidationChallenge(
        database,
        plan.retailerId,
        30,
      );
      if (challenge.length !== 30) {
        throw new Error(`${plan.retailerId} has ${challenge.length}/30 authoritative references`);
      }
      const path = receiptPath(root, plan);
      assertReceiptContained(root, path);
      const evidence = evidenceTools.validateStrategyEvidence(
        JSON.parse(readFileSync(path, "utf8")),
        {
          retailerId: plan.retailerId,
          purpose: plan.purpose,
          strategyVersion: plan.toVersion,
          strategy,
          verificationPublicKey: trackedPublicKey,
          authoritativeRefs: challenge,
        },
      );
      comparePublicKeys(trackedPublicKey, evidence);
      if (
        evidence.executor.mode !== "trusted-live-host"
        || evidence.executor.sourceCommit !== sourceCommit
        || evidence.executor.artifactSha256 !== build.expectedValidator
        || evidence.executor.challengeAlgorithm !== CHALLENGE_ALGORITHM
        || evidence.attempted !== 30
        || evidence.valid < 27
        || evidence.activatable !== true
        || canonicalJson(evidence.samples.map(({ ref }) => ref)) !== canonicalJson(challenge)
      ) {
        throw new Error(
          `${plan.retailerId}/${plan.purpose} receipt is not bound to the trusted rollout`,
        );
      }
      if (Date.parse(evidence.validatedAt) > Date.now()) {
        throw new Error(`${plan.retailerId}/${plan.purpose} receipt is future-dated`);
      }
      const desired = desiredByRetailer.get(plan.retailerId);
      if (desired === undefined) throw new Error(`Missing desired config for ${plan.retailerId}`);
      desired.strategyVersions[plan.purpose] = plan.toVersion;
      desired.validation[plan.purpose] = {
        ...desired.validation[plan.purpose],
        externallyValidated: true,
        validatedAt: evidence.validatedAt,
        sampleSize: evidence.attempted,
        successes: evidence.valid,
        score: evidence.score,
        receiptPath: `data/validation/${plan.retailerId}-${plan.purpose}-v${plan.toVersion}.json`,
        receiptSha256: evidenceTools.validationReceiptSha256(evidence),
      };
      receipts.push({
        retailerId: plan.retailerId,
        purpose: plan.purpose,
        receiptSha256: evidenceTools.validationReceiptSha256(evidence),
        sampleSetSha256: evidence.sampleSetSha256,
      });
    }
  } finally {
    database.close();
  }

  for (const [retailerId, desired] of desiredByRetailer) {
    configTools.RetailerConfigSchema.parse(desired);
    const overlayConfig = readJsonFile(
      resolve(root, OVERLAY_PATH, `${retailerId}.json`),
      `prepared overlay ${retailerId}`,
    );
    for (const purpose of ["discovery", "extraction"]) {
      if (
        overlayConfig.strategyVersions[purpose] !== desired.strategyVersions[purpose]
        || canonicalJson(overlayConfig[purpose]) !== canonicalJson(desired[purpose])
      ) {
        throw new Error(`${retailerId}/${purpose} overlay strategy differs from signed evidence`);
      }
    }
  }

  const updates = configs.map((entry) => ({
    path: entry.path,
    originalSha256: sha256(readFileSync(resolve(root, entry.path))),
    content: formattedJson(desiredByRetailer.get(entry.retailerId)),
  }));
  writeConfigBatchAtomically(root, updates);
  return { root, sourceCommit, receipts, configs: configs.map(({ path }) => path) };
}

async function main() {
  const result = await applyValidationSuccessors(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    event: "validation-successors-applied",
    sourceCommit: result.sourceCommit,
    strategies: result.receipts.length,
    configs: result.configs,
    databaseMutation: false,
    activationPerformed: false,
  })}\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
