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
    "--retailer <id>",
    "register only one retailer configuration; without this filter, bootstrap-inactive "
      + "mode deactivates and retires every currently active strategy of every retailer",
  );
command.parse(process.argv);
const options = command.opts<{
  bootstrapInactive?: boolean;
  retailer?: string;
}>();
const database = openDatabase(config.databasePath);
try {
  const retailers = loadRetailerConfigs(resolve(config.projectRoot, "retailers"))
    .filter((retailer) => options.retailer === undefined || retailer.id === options.retailer);
  if (retailers.length === 0) {
    throw new Error(`No retailer configuration matches ${options.retailer}`);
  }
  registerRetailerConfigs(database, retailers, {
    projectRoot: config.projectRoot,
    mode: options.bootstrapInactive === true ? "bootstrap-inactive" : "activate",
  });
  process.stdout.write(`Registered ${retailers.length} retailer configurations.\n`);
} finally {
  database.close();
}
