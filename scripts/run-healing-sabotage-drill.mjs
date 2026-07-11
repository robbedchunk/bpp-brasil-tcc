#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

if (Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error("The healing sabotage drill requires the provisioned Node.js 24 runtime");
}
const root = resolve(process.env.PROJECT_ROOT ?? ".");
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
let confirmed = false;
let authorizedSpendUsd;
for (let index = 0; index < process.argv.slice(2).length; index += 1) {
  const argument = process.argv.slice(2)[index];
  if (argument === "--confirm-staging-sabotage") confirmed = true;
  else if (argument === "--authorize-live-spend-usd") {
    authorizedSpendUsd = process.argv.slice(2)[index + 1];
    if (authorizedSpendUsd === undefined) throw new Error(`${argument} requires a value`);
    index += 1;
  } else {
    throw new Error(`Unknown healing sabotage drill argument: ${argument}`);
  }
}
if (!confirmed) throw new Error("--confirm-staging-sabotage is required");
if (authorizedSpendUsd === undefined) {
  throw new Error("--authorize-live-spend-usd is required");
}
const installReceiptPath = resolve(root, "var/operations/systemd-install.json");
const stat = lstatSync(installReceiptPath);
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
  throw new Error("The installed-release receipt is absent or unsafe");
}
const installed = JSON.parse(readFileSync(installReceiptPath, "utf8"));
if (installed.schemaVersion !== 2 || typeof installed.releasePath !== "string"
  || !isAbsolute(installed.releasePath)) {
  throw new Error("The installed-release receipt is malformed");
}
const runner = resolve(installed.releasePath, "dist/ops/healing-drill.js");
if (!existsSync(runner)) {
  throw new Error("The installed frozen release does not contain the healing drill runner");
}
const configuredDatabase = process.env.DATABASE_PATH;
const databasePath = configuredDatabase === undefined
  ? resolve(root, "data/precos.sqlite")
  : resolve(root, configuredDatabase);
const executed = spawnSync(process.execPath, [
  runner,
  "run",
  "--project-root",
  root,
  "--database",
  databasePath,
  "--release-path",
  installed.releasePath,
  "--public-key",
  resolve(root, "ops/validation-attestation-public.pem"),
  "--private-key",
  resolve(root, "var/operations/validation-attestation-private.pem"),
  "--confirm-staging-sabotage",
  "--authorize-live-spend-usd",
  authorizedSpendUsd,
], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (executed.error !== undefined) throw executed.error;
process.exit(executed.status ?? 1);
