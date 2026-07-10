#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import type Database from "better-sqlite3";

import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import {
  activeRetailerIds,
  readStatusReport,
  type StatusReport,
} from "./db/repositories.js";
import { runCollection } from "./pipeline/collect.js";
import { runDaily } from "./pipeline/daily.js";
import {
  runDiscovery,
  type RunSummary,
} from "./pipeline/discover.js";

interface PipelineCliOptions {
  limit: number;
  dryRun: boolean;
}

export interface CliDependencies {
  databasePath?: string;
  database?: Database.Database;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  runDiscovery?: (
    retailerId: string,
    options: PipelineCliOptions,
  ) => Promise<RunSummary>;
  runCollection?: (
    retailerId: string,
    options: PipelineCliOptions,
  ) => Promise<RunSummary>;
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
  const config = () => loadConfig(dependencies.env);
  const withDatabase = async <T>(
    action: (database: Database.Database) => T | Promise<T>,
  ): Promise<T> => {
    const database = dependencies.database ?? openDatabase(databasePath());
    try {
      return await action(database);
    } finally {
      if (dependencies.database === undefined) database.close();
    }
  };

  const command = new Command()
    .name("precos")
    .description("Deterministic online-price collection and evidence CLI")
    .showHelpAfterError()
    .configureOutput({ writeErr: stderr, writeOut: stdout });

  command
    .command("status")
    .description("Report collection health from the local database")
    .option("--json", "emit only the JSON status object")
    .action(async (options: { json?: boolean }) => {
      await withDatabase((database) => {
        const report = readStatusReport(database, now());
        stdout(options.json === true ? `${JSON.stringify(report)}\n` : formatHumanStatus(report));
      });
    });

  const positiveLimit = (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("--limit must be a positive integer");
    }
    return Math.min(parsed, 2_000);
  };
  const pipelineCommand = (
    name: "discover" | "collect",
    description: string,
  ): void => {
    command
      .command(name)
      .description(description)
      .option("--retailer <id>", "run only one registered retailer")
      .option("--limit <count>", "maximum products/pages, capped at 2000", positiveLimit)
      .option("--dry-run", "execute without writing pipeline evidence")
      .option("--json", "emit only JSON summaries")
      .action(async (options: {
        retailer?: string;
        limit?: number;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const summaries = await withDatabase(async (database) => {
          const retailerIds = options.retailer === undefined
            ? activeRetailerIds(database)
            : [options.retailer];
          const limit = Math.min(options.limit ?? config().dailyPageCap, 2_000);
          const pipelineOptions = { limit, dryRun: options.dryRun === true };
          const results: RunSummary[] = [];
          for (const retailerId of retailerIds) {
            if (name === "discover") {
              results.push(
                dependencies.runDiscovery === undefined
                  ? await runDiscovery(retailerId, {
                      database,
                      ...pipelineOptions,
                    })
                  : await dependencies.runDiscovery(retailerId, pipelineOptions),
              );
            } else {
              results.push(
                dependencies.runCollection === undefined
                  ? await runCollection(retailerId, {
                      database,
                      ...pipelineOptions,
                      concurrency: config().pageConcurrency,
                      rawHtmlRoot: resolve(config().projectRoot, "data/raw-html"),
                    })
                  : await dependencies.runCollection(retailerId, pipelineOptions),
              );
            }
          }
          return results;
        });
        if (options.json === true) {
          stdout(`${JSON.stringify(summaries)}\n`);
        } else {
          for (const summary of summaries) {
            stdout(
              `${summary.stage} ${summary.retailerId}: ${summary.ok}/${summary.attempted} ok (${summary.status})\n`,
            );
          }
        }
      });
  };

  pipelineCommand("discover", "Discover and persist retailer product references");
  pipelineCommand("collect", "Collect deterministic price observations");

  command
    .command("daily")
    .description("Run daily collection for every active retailer")
    .option("--limit <count>", "maximum products per retailer, capped at 2000", positiveLimit)
    .option("--dry-run", "execute without writing pipeline evidence")
    .option("--json", "emit only the JSON summary")
    .action(async (options: { limit?: number; dryRun?: boolean; json?: boolean }) => {
      const result = await withDatabase((database) => runDaily({
        database,
        limit: Math.min(options.limit ?? config().dailyPageCap, 2_000),
        dryRun: options.dryRun === true,
        concurrency: config().pageConcurrency,
        rawHtmlRoot: resolve(config().projectRoot, "data/raw-html"),
        now,
      }));
      stdout(options.json === true
        ? `${JSON.stringify(result)}\n`
        : `daily: ${result.terminal}/${result.retailers} retailers terminal\n`);
    });

  command
    .command("db")
    .description("Manage the local SQLite database")
    .command("init")
    .description("Create or migrate the local SQLite database")
    .action(() => {
      const path = databasePath();
      if (dependencies.database === undefined) {
        const database = openDatabase(path);
        database.close();
      }
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
