#!/usr/bin/env node

import { resolve } from "node:path";

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
const database = openDatabase(config.databasePath);
try {
  const retailers = loadRetailerConfigs(resolve(config.projectRoot, "retailers"));
  registerRetailerConfigs(database, retailers);
  process.stdout.write(`Registered ${retailers.length} retailer configurations.\n`);
} finally {
  database.close();
}
