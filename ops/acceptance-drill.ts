#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { runAlertDrill, runBackupDrill } from "../src/ops/acceptance-drills.js";

interface CliOptions {
  drill: "alert" | "backup";
  json: boolean;
}

function parseArguments(args: string[]): CliOptions {
  const drill = args[0];
  if (drill !== "alert" && drill !== "backup") {
    throw new Error("usage: acceptance:drill <alert|backup> --confirm-safe-drill [--json]");
  }
  let confirmed = false;
  let json = false;
  for (const argument of args.slice(1)) {
    if (argument === "--confirm-safe-drill") confirmed = true;
    else if (argument === "--json") json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!confirmed) throw new Error("--confirm-safe-drill is required");
  return { drill, json };
}

async function main(): Promise<void> {
  let cli: CliOptions;
  try {
    cli = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`acceptance:drill: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const projectRoot = resolve(process.env.PROJECT_ROOT ?? ".");
    const envPath = resolve(projectRoot, ".env");
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    const config = loadConfig({ ...process.env, PROJECT_ROOT: projectRoot });
    const common = {
      projectRoot,
      databasePath: config.databasePath,
      now: () => new Date(),
      privateReceiptPath: resolve(projectRoot, `var/acceptance/${cli.drill}-drill.json`),
      publicReceiptPath: resolve(projectRoot, `data/acceptance/evidence/${cli.drill}-drill.json`),
    };
    const receipt = cli.drill === "alert"
      ? await runAlertDrill({
          ...common,
          fallbackPath: resolve(projectRoot, "var/log/alerts.jsonl"),
          ...(config.ntfyTopic === undefined ? {} : { ntfyTopic: config.ntfyTopic }),
        })
      : await runBackupDrill({
          ...common,
          backupDirectory: resolve(projectRoot, "var/backups"),
        });
    process.stdout.write(cli.json ? `${JSON.stringify(receipt)}\n` : `Acceptance ${cli.drill} drill: ${receipt.status.toUpperCase()}\n`);
    process.exitCode = receipt.status === "fail" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`acceptance:drill: ${error instanceof Error ? error.message : "runtime error"}\n`);
    process.exitCode = 2;
  }
}

await main();
