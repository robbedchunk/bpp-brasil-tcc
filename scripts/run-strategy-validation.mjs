#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const runner = resolve(root, "dist/scripts/validate-strategies.js");
const status = execFileSync("git", [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
  "--",
  "scripts",
  "src",
  "retailers",
  "ops/validator-bundle.sha256",
  "package.json",
  "package-lock.json",
], { cwd: root, encoding: "utf8" }).trimEnd();
const configOnlyResume = status !== ""
  && status.split("\n").every((line) => /^ M retailers\/[a-z0-9-]+\.json$/u.test(line));

if (status === "") {
  const built = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (built.error !== undefined) throw built.error;
  if (built.status !== 0) process.exit(built.status ?? 1);
} else if (configOnlyResume) {
  if (!existsSync(runner)) {
    throw new Error(
      "The config-bound rollout can resume only with its original trusted validator bundle",
    );
  }
} else if (!existsSync(runner)) {
  throw new Error("Build the trusted validator from a clean committed tree before validation");
}

for (const asset of [
  runner,
  resolve(root, "dist/scripts/schema.sql"),
  resolve(root, "dist/scripts/migrations/014_strategy_validation_authorization.sql"),
  resolve(root, "dist/scripts/migrations/015_runtime_safety_reconciliation.sql"),
  resolve(root, "dist/scripts/migrations/016_discovery_tier_semantics.sql"),
]) {
  if (!existsSync(asset)) {
    throw new Error(`Trusted validator runtime asset is absent: ${asset}`);
  }
}

const executed = spawnSync(process.execPath, [runner, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});
if (executed.error !== undefined) throw executed.error;
process.exit(executed.status ?? 1);
