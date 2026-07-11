#!/usr/bin/env node

import { resolve } from "node:path";

import { Command } from "commander";

import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import {
  loadRetailerConfigs,
  registerRetailerConfigs,
} from "../src/retailers/config.js";

try {
  process.loadEnvFile();
} catch (error) {
  if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

const config = loadConfig();
const command = new Command()
  .option(
    "--bootstrap-inactive",
    "register configuration identities without activating or trusting validation summaries",
  )
  .option(
    "--verification-public-key <path>",
    "tracked Ed25519 validation verification key",
    "ops/validation-attestation-public.pem",
  );
command.parse(process.argv);
const options = command.opts<{
  bootstrapInactive?: boolean;
  verificationPublicKey: string;
}>();
const database = openDatabase(config.databasePath);
try {
  const retailers = loadRetailerConfigs(resolve(config.projectRoot, "retailers"));
  registerRetailerConfigs(database, retailers, {
    projectRoot: config.projectRoot,
    verificationPublicKeyPath: resolve(
      config.projectRoot,
      options.verificationPublicKey,
    ),
    mode: options.bootstrapInactive === true ? "bootstrap-inactive" : "activate",
  });
  process.stdout.write(`Registered ${retailers.length} retailer configurations.\n`);
} finally {
  database.close();
}
