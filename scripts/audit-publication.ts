#!/usr/bin/env node

import { resolve } from "node:path";

import { auditPublication } from "../src/publication/audit.js";

interface CliOptions {
  json: boolean;
  projectRoot: string;
  databasePath: string;
  requireClean: boolean;
}

function parseArguments(arguments_: string[]): CliOptions {
  let json = false;
  let projectRoot = resolve(".");
  let databasePath: string | undefined;
  let requireClean = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") json = true;
    else if (argument === "--require-clean") requireClean = true;
    else if (argument === "--project-root" || argument === "--database") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--project-root") projectRoot = resolve(value);
      else databasePath = resolve(value);
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }
  return {
    json,
    projectRoot,
    databasePath: databasePath ?? resolve(projectRoot, "data/precos.sqlite"),
    requireClean,
  };
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`audit:publication: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const report = await auditPublication({
      projectRoot: options.projectRoot,
      databasePath: options.databasePath,
      now: () => new Date(),
      requireClean: options.requireClean,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(`Publication audit: ${report.status.toUpperCase()}\n`);
      for (const item of report.findings) {
        process.stdout.write(`- ${item.ruleId} ${item.location}: ${item.message}\n`);
      }
    }
    if (report.status === "fail") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`audit:publication: ${error instanceof Error ? error.message : "audit failed"}\n`);
    process.exitCode = 2;
  }
}

await main();
