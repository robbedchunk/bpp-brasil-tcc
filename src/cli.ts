#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { readStatusReport, type StatusReport } from "./db/repositories.js";

export interface CliDependencies {
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function formatHumanStatus(report: StatusReport): string {
  const headings = [
    "RETAILER",
    "ACTIVE",
    "DEGRADED",
    "DAY",
    "ATTEMPTED",
    "OK",
    "FAILED",
    "SUCCESS",
  ];
  const rows = report.retailers.map((retailer) => [
    retailer.name,
    retailer.active ? "yes" : "no",
    retailer.degraded ? "yes" : "no",
    retailer.latestRun?.collectionDay ?? "-",
    String(retailer.latestRun?.attempted ?? 0),
    String(retailer.latestRun?.ok ?? 0),
    String(retailer.latestRun?.failed ?? 0),
    retailer.latestRun === null
      ? "-"
      : `${(retailer.latestRun.successRate * 100).toFixed(1)}%`,
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ");
  const table = rows.length === 0
    ? `${formatRow(headings)}\n(no retailers)`
    : [formatRow(headings), ...rows.map(formatRow)].join("\n");

  return `${table}\nHEARTBEAT  ${report.staleHeartbeat ? "STALE" : "FRESH"}\n`;
}

export function buildCli(dependencies: CliDependencies = {}): Command {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const now = dependencies.now ?? (() => new Date());
  const databasePath = (): string =>
    dependencies.databasePath ?? loadConfig(dependencies.env).databasePath;

  const command = new Command()
    .name("precos")
    .description("Deterministic online-price collection and evidence CLI")
    .showHelpAfterError()
    .configureOutput({ writeErr: stderr, writeOut: stdout });

  command
    .command("status")
    .description("Report collection health from the local database")
    .option("--json", "emit only the JSON status object")
    .action((options: { json?: boolean }) => {
      const database = openDatabase(databasePath());
      try {
        const report = readStatusReport(database, now());
        stdout(options.json === true ? `${JSON.stringify(report)}\n` : formatHumanStatus(report));
      } finally {
        database.close();
      }
    });

  command
    .command("db")
    .description("Manage the local SQLite database")
    .command("init")
    .description("Create or migrate the local SQLite database")
    .action(() => {
      const path = databasePath();
      const database = openDatabase(path);
      database.close();
      stdout("Database initialized.\n");
    });

  return command;
}

function loadEnvironmentFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    loadEnvironmentFile();
    await buildCli().parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`precos: ${message}\n`);
    process.exitCode = 1;
  }
}
