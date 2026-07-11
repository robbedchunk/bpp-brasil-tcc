#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OVERLAY_PATH,
  PLAN_PATH,
  SUCCESSOR_TOOL_PATHS,
  assertProjectRoot,
  assertTrackedUnmodified,
  assertTrustedImplementationClean,
  inspectPlannedConfigs,
  parseSuccessorPlan,
  readJsonFile,
  writePrivateOverlay,
} from "./successor-tooling.mjs";

function parseArguments(arguments_) {
  let root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name !== "--root" || value === undefined) {
      throw new Error("Usage: node scripts/prepare-validation-successors.mjs [--root <path>]");
    }
    root = resolve(value);
  }
  return { root: assertProjectRoot(root) };
}

export function prepareValidationSuccessors(options) {
  const root = assertProjectRoot(options.root);
  assertTrustedImplementationClean(root);
  const plans = parseSuccessorPlan(readJsonFile(resolve(root, PLAN_PATH), "successor plan"));
  const configs = inspectPlannedConfigs(root, plans);
  assertTrackedUnmodified(root, SUCCESSOR_TOOL_PATHS);
  const overlay = writePrivateOverlay(root, configs, resolve(root, OVERLAY_PATH));
  return { root, overlay, plans, configs };
}

async function main() {
  const result = prepareValidationSuccessors(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    event: "validation-successors-prepared",
    overlay: result.overlay,
    retailers: result.configs.length,
    strategies: result.plans.length,
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
