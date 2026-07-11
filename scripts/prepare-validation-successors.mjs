#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OVERLAY_PATH,
  PLAN_PATH,
  RECOVERY_PLAN_PATH,
  SUCCESSOR_TOOL_PATHS,
  assertProjectRoot,
  assertTrackedUnmodified,
  assertTrustedImplementationClean,
  git,
  inspectPlannedConfigs,
  inspectRecoveryConfigs,
  parseRecoveryPlan,
  parseSuccessorPlan,
  readJsonFile,
  recoveryOverlayPath,
  verifyCommittedRecoveryPlan,
  verifyRecoveryFailedAttemptFiles,
  writePrivateOverlay,
} from "./successor-tooling.mjs";

export function parseArguments(arguments_) {
  let root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let recovery = false;
  for (let index = 0; index < arguments_.length;) {
    const name = arguments_[index];
    if (name === "--recovery") {
      recovery = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (name !== "--root" || value === undefined) {
      throw new Error(
        "Usage: node scripts/prepare-validation-successors.mjs [--root <path>] [--recovery]",
      );
    }
    root = resolve(value);
    index += 2;
  }
  return { root: assertProjectRoot(root), recovery };
}

export function prepareValidationSuccessors(options) {
  const root = assertProjectRoot(options.root);
  assertTrustedImplementationClean(root);
  if (options.recovery === true) {
    const recovery = parseRecoveryPlan(
      readJsonFile(resolve(root, RECOVERY_PLAN_PATH), "successor recovery plan"),
    );
    const configs = inspectRecoveryConfigs(root, recovery);
    assertTrackedUnmodified(root, SUCCESSOR_TOOL_PATHS);
    verifyRecoveryFailedAttemptFiles(root, recovery);
    const sourceCommit = verifyCommittedRecoveryPlan(
      root,
      recovery,
      configs,
      // Preparation is deliberately bound to the clean checked-out source.
      git(root, ["rev-parse", "--verify", "HEAD"]),
    );
    const overlay = writePrivateOverlay(root, configs, recoveryOverlayPath(root, recovery));
    return { root, overlay, plans: recovery.plans, configs, recovery: true, sourceCommit };
  }
  const plans = parseSuccessorPlan(readJsonFile(resolve(root, PLAN_PATH), "successor plan"));
  const configs = inspectPlannedConfigs(root, plans);
  assertTrackedUnmodified(root, SUCCESSOR_TOOL_PATHS);
  const overlay = writePrivateOverlay(root, configs, resolve(root, OVERLAY_PATH));
  return { root, overlay, plans, configs, recovery: false };
}


async function main() {
  const result = prepareValidationSuccessors(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    event: "validation-successors-prepared",
    overlay: result.overlay,
    retailers: result.configs.length,
    strategies: result.plans.length,
    recoveryMode: result.recovery,
    directoryMode: "0700",
    fileMode: "0600",
  })}\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
