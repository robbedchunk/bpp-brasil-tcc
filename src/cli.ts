#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import type Database from "better-sqlite3";

import {
  buildReviewSample,
  classifyNewProducts,
} from "./classify/classify.js";
import {
  createOpenAIBatchClient,
  finalizeClassificationBatch,
  pollClassificationBatch,
  submitClassificationBatch,
  type BatchFinalizeSummary,
  type BatchPollSummary,
  type OpenAIBatchClient,
} from "./classify/batch.js";
import {
  classificationModelFromEnv,
  OpenAIProductClassifier,
} from "./classify/openai-provider.js";
import type { ProductClassifier } from "./classify/provider.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import {
  activeRetailerIds,
  latestTerminalCollectionRunId,
  readStatusReport,
  type StatusReport,
} from "./db/repositories.js";
import { runCollection } from "./pipeline/collect.js";
import { runDaily } from "./pipeline/daily.js";
import {
  runDiscovery,
  type RunSummary,
} from "./pipeline/discover.js";
import { loadRetailerConfigs } from "./retailers/config.js";
import {
  createAlertSink,
  type AlertSink,
} from "./ops/alerts.js";
import {
  checkHeartbeat,
  latestSuccessfulHeartbeat,
} from "./ops/heartbeat.js";
import { withProcessLock } from "./ops/lock.js";
import { BudgetGuard } from "./ops/budget.js";
import {
  CodexStrategyGenerator,
  resolveExplorerApiKey,
} from "./explorer/codex-provider.js";
import {
  exploreRetailer as runExploreRetailer,
  type ExploreRetailerDependencies,
  type ExplorationOutcome,
} from "./explorer/explore.js";
import type {
  StrategyGenerator,
  StrategyPurpose,
} from "./explorer/provider.js";
import {
  healRetailer as runHealRetailer,
  type HealingOutcome,
  type HealRetailerDependencies,
} from "./healing/heal.js";
import { monitorRun } from "./healing/monitor.js";

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
  alertSink?: AlertSink;
  lockPath?: string;
  productClassifier?: ProductClassifier;
  productClassifierFactory?: (model: string, apiKey: string) => ProductClassifier;
  classificationBatchClient?: OpenAIBatchClient;
  budgetGuard?: BudgetGuard;
  strategyGenerator?: StrategyGenerator;
  exploreRetailer?: (
    retailerId: string,
    purpose: StrategyPurpose,
    dependencies: ExploreRetailerDependencies,
  ) => Promise<ExplorationOutcome>;
  healRetailer?: (
    retailerId: string,
    purpose: StrategyPurpose,
    dependencies: HealRetailerDependencies,
  ) => Promise<HealingOutcome>;
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
  const retailerOptions = (retailerId: string): { politeDelayMs?: { min: number; max: number } } => {
    const retailer = loadRetailerConfigs(resolve(config().projectRoot, "retailers"))
      .find(({ id }) => id === retailerId);
    return retailer === undefined ? {} : { politeDelayMs: retailer.politeDelayMs };
  };
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
      .option("--dry-run", "report a persisted-data plan without network or writes")
      .option("--json", "emit only JSON summaries")
      .action(async (options: {
        retailer?: string;
        limit?: number;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const summaries = await withProcessLock(
          dependencies.lockPath ?? resolve(config().projectRoot, "var/precos-pipeline.lock"),
          () => withDatabase(async (database) => {
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
                      ...retailerOptions(retailerId),
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
                      ...retailerOptions(retailerId),
                    })
                  : await dependencies.runCollection(retailerId, pipelineOptions),
              );
            }
          }
            return results;
          }),
        );
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

  const strategyPurpose = (value: string): StrategyPurpose => {
    if (value !== "discovery" && value !== "extraction") {
      throw new Error("--purpose must be discovery or extraction");
    }
    return value;
  };

  command
    .command("explore")
    .description("Generate and externally validate a disposable strategy candidate")
    .requiredOption("--retailer <id>", "registered retailer ID")
    .option(
      "--purpose <purpose>",
      "strategy purpose: discovery or extraction",
      strategyPurpose,
      "extraction",
    )
    .option("--json", "emit only JSON")
    .action(async (options: {
      retailer: string;
      purpose: StrategyPurpose;
      json?: boolean;
    }) => {
      const applicationConfig = config();
      const environment = dependencies.env ?? process.env;
      const apiKey = resolveExplorerApiKey(environment);
      const generator = dependencies.strategyGenerator ?? (
        apiKey === undefined
          ? undefined
          : new CodexStrategyGenerator({ apiKey, env: environment })
      );
      const outcome = await withProcessLock(
        dependencies.lockPath ?? resolve(applicationConfig.projectRoot, "var/precos-explorer.lock"),
        () => withDatabase((database) =>
          (dependencies.exploreRetailer ?? runExploreRetailer)(
            options.retailer,
            options.purpose,
            {
              database,
              ...(generator === undefined ? {} : { generator }),
              env: environment,
              now,
            },
          )),
      );
      if (!outcome.activated && (
        outcome.outcome === "provider_unavailable"
        || outcome.outcome === "budget_paused"
        || outcome.outcome === "budget_exhausted"
        || outcome.outcome === "provider_failed"
      )) {
        const sink = dependencies.alertSink ?? createAlertSink({
          ...(applicationConfig.ntfyTopic === undefined
            ? {}
            : { ntfyTopic: applicationConfig.ntfyTopic }),
          fallbackPath: resolve(applicationConfig.projectRoot, "var/log/alerts.jsonl"),
          now,
        });
        await sink.send({
          severity: "warning",
          title: "Strategy exploration pending",
          message: outcome.outcome === "provider_unavailable"
            ? "Explorer credentials are not configured; the active strategy was preserved"
            : "Strategy exploration stopped under its configured safety controls",
          details: {
            retailerId: options.retailer,
            purpose: options.purpose,
            outcome: outcome.outcome,
            attempts: outcome.attempts,
          },
        });
      }
      stdout(options.json === true
        ? `${JSON.stringify(outcome)}\n`
        : `explore ${options.retailer}/${options.purpose}: ${outcome.outcome}; ${outcome.attempts} attempt(s)\n`);
    });

  command
    .command("heal")
    .description("Regenerate a drifted strategy through trusted exploration")
    .requiredOption("--retailer <id>", "registered retailer ID")
    .option("--run <id>", "terminal collection run that detected drift")
    .option(
      "--purpose <purpose>",
      "strategy purpose: discovery or extraction",
      strategyPurpose,
      "extraction",
    )
    .option("--json", "emit only JSON")
    .action(async (options: {
      retailer: string;
      run?: string;
      purpose: StrategyPurpose;
      json?: boolean;
    }) => {
      const applicationConfig = config();
      const environment = dependencies.env ?? process.env;
      const apiKey = resolveExplorerApiKey(environment);
      const generator = dependencies.strategyGenerator ?? (
        apiKey === undefined
          ? undefined
          : new CodexStrategyGenerator({ apiKey, env: environment })
      );
      const sink = dependencies.alertSink ?? createAlertSink({
        ...(applicationConfig.ntfyTopic === undefined
          ? {}
          : { ntfyTopic: applicationConfig.ntfyTopic }),
        fallbackPath: resolve(applicationConfig.projectRoot, "var/log/alerts.jsonl"),
        now,
      });
      const outcome = await withProcessLock(
        dependencies.lockPath ?? resolve(applicationConfig.projectRoot, "var/precos-explorer.lock"),
        () => withDatabase((database) => {
          const onsetRunId = options.run
            ?? latestTerminalCollectionRunId(database, options.retailer);
          if (onsetRunId === null) {
            throw new Error(`No terminal collection run exists for ${options.retailer}`);
          }
          return (dependencies.healRetailer ?? runHealRetailer)(
            options.retailer,
            options.purpose,
            {
              database,
              onsetRunId,
              ...(generator === undefined ? {} : { generator }),
              alertSink: sink,
              env: environment,
              now,
            },
          );
        }),
      );
      stdout(options.json === true
        ? `${JSON.stringify(outcome)}\n`
        : `heal ${options.retailer}/${options.purpose}: ${outcome.status}; ${outcome.attempts} attempt(s)\n`);
    });

  const classificationVersion = (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("--version must be a positive integer");
    }
    return parsed;
  };
  const classificationThreshold = (value: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new Error("--confidence-threshold must be between 0 and 1");
    }
    return parsed;
  };
  const reviewSampleLimit = (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("--review-sample must be a positive integer");
    }
    return Math.min(parsed, 200);
  };
  const classificationLockPath = (): string =>
    dependencies.lockPath ?? resolve(config().projectRoot, "var/precos-classification.lock");

  command
    .command("classify")
    .description("Classify new products into São Paulo IPCA food-at-home subitems")
    .option("--batch-size <count>", "classification batch size", positiveLimit, 50)
    .option("--version <number>", "append-only classification version", classificationVersion, 1)
    .option(
      "--confidence-threshold <number>",
      "minimum confidence for an assigned item",
      classificationThreshold,
      0.8,
    )
    .option("--dry-run", "report pending batches without API or evidence writes")
    .option("--review-sample <count>", "include a deterministic stratified review sample", reviewSampleLimit)
    .option("--json", "emit only the JSON classification summary")
    .action(async (options: {
      batchSize: number;
      version: number;
      confidenceThreshold: number;
      dryRun?: boolean;
      reviewSample?: number;
      json?: boolean;
    }) => {
      const applicationConfig = config();
      const classificationModel = classificationModelFromEnv(dependencies.env ?? process.env);
      const provider = dependencies.productClassifier ?? (
        applicationConfig.openaiApiKey === undefined
          ? undefined
          : dependencies.productClassifierFactory?.(
              classificationModel,
              applicationConfig.openaiApiKey,
            ) ?? new OpenAIProductClassifier({
              apiKey: applicationConfig.openaiApiKey,
              model: classificationModel,
            })
      );
      const output = await withProcessLock(
        classificationLockPath(),
        () => withDatabase(async (database) => {
          const summary = await classifyNewProducts({
            batchSize: options.batchSize,
            version: options.version,
            confidenceThreshold: options.confidenceThreshold,
            dryRun: options.dryRun === true,
          }, {
            database,
            ...(provider === undefined ? {} : { provider }),
            budgetGuard: dependencies.budgetGuard ?? new BudgetGuard(),
            classificationModel,
            now,
          });
          return options.reviewSample === undefined
            ? summary
            : {
                ...summary,
                reviewSample: buildReviewSample(database, {
                  limit: options.reviewSample,
                  version: options.version,
                }),
              };
        }),
      );
      const summary = output;

      if (!summary.dryRun && summary.pending > 0) {
        const sink = dependencies.alertSink ?? createAlertSink({
          fallbackPath: resolve(applicationConfig.projectRoot, "var/log/alerts.jsonl"),
          now,
        });
        await sink.send({
          severity: "warning",
          title: "IPCA classification pending",
          message: summary.status === "provider_unavailable"
            ? "Classification credentials are not configured; products remain pending"
            : "Classification work remains pending under the configured safety controls",
          details: { pending: summary.pending, version: summary.version },
        });
      }

      stdout(options.json === true || options.reviewSample !== undefined
        ? `${JSON.stringify(output)}\n`
        : `classify v${summary.version}: ${summary.classified}/${summary.eligible} evidence rows; ${summary.pending} pending (${summary.status})\n`);
    });

  const batchLimit = (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 50_000) {
      throw new Error("--limit must be an integer from 1 to 50000");
    }
    return parsed;
  };
  const batchCommand = command
    .command("classify-batch")
    .description("Submit, poll, or finalize asynchronous OpenAI classification backfills");

  batchCommand
    .command("submit")
    .description("Upload and submit an initial backfill or reclassification batch")
    .option("--version <number>", "append-only classification version", classificationVersion, 1)
    .option(
      "--confidence-threshold <number>",
      "minimum confidence for an assigned item",
      classificationThreshold,
      0.8,
    )
    .option("--limit <count>", "maximum requests, capped at 50000", batchLimit, 50_000)
    .option("--json", "emit only JSON")
    .action(async (options: {
      version: number;
      confidenceThreshold: number;
      limit: number;
      json?: boolean;
    }) => {
      const applicationConfig = config();
      const model = classificationModelFromEnv(dependencies.env ?? process.env);
      const client = dependencies.classificationBatchClient ?? (
        applicationConfig.openaiApiKey === undefined
          ? undefined
          : createOpenAIBatchClient(applicationConfig.openaiApiKey)
      );
      const result = await withProcessLock(
        classificationLockPath(),
        () => withDatabase((database) => submitClassificationBatch({
          version: options.version,
          confidenceThreshold: options.confidenceThreshold,
          limit: options.limit,
        }, {
          database,
          ...(client === undefined ? {} : { client }),
          budgetGuard: dependencies.budgetGuard ?? new BudgetGuard(),
          model,
          now,
        })),
      );
      if (result.status === "provider_unavailable" && result.pending > 0) {
        const sink = dependencies.alertSink ?? createAlertSink({
          fallbackPath: resolve(applicationConfig.projectRoot, "var/log/alerts.jsonl"),
          now,
        });
        await sink.send({
          severity: "warning",
          title: "IPCA batch classification pending",
          message: "Batch classification credentials are not configured; products remain pending",
          details: { pending: result.pending, version: options.version },
        });
      }
      stdout(options.json === true
        ? `${JSON.stringify(result)}\n`
        : `classification batch: ${result.status}; ${result.submitted} submitted, ${result.pending} pending\n`);
    });

  const remoteBatchAction = (
    name: "poll" | "finalize",
    description: string,
  ): void => {
    batchCommand
      .command(name)
      .description(description)
      .requiredOption("--job <id>", "local classification batch job ID")
      .option("--json", "emit only JSON")
      .action(async (options: { job: string; json?: boolean }) => {
        const applicationConfig = config();
        const model = classificationModelFromEnv(dependencies.env ?? process.env);
        const client = dependencies.classificationBatchClient ?? (
          applicationConfig.openaiApiKey === undefined
            ? undefined
            : createOpenAIBatchClient(applicationConfig.openaiApiKey)
        );
        if (client === undefined) throw new Error("OpenAI Batch credentials are not configured");
        const result = await withProcessLock(
          classificationLockPath(),
          () => withDatabase<BatchPollSummary | BatchFinalizeSummary>((database) => {
            const batchDependencies = {
              database,
              client,
              budgetGuard: dependencies.budgetGuard ?? new BudgetGuard(),
              model,
              now,
            };
            return name === "poll"
              ? pollClassificationBatch(options.job, batchDependencies)
              : finalizeClassificationBatch(options.job, batchDependencies);
          }),
        );
        stdout(options.json === true
          ? `${JSON.stringify(result)}\n`
          : `classification batch ${options.job}: ${result.status}\n`);
      });
  };
  remoteBatchAction("poll", "Poll a submitted asynchronous classification batch");
  remoteBatchAction("finalize", "Finalize terminal batch output and append evidence");

  command
    .command("daily")
    .description("Run daily collection for every active retailer")
    .option("--limit <count>", "maximum products per retailer, capped at 2000", positiveLimit)
    .option("--dry-run", "report a persisted-data plan without network or writes")
    .option("--json", "emit only the JSON summary")
    .action(async (options: { limit?: number; dryRun?: boolean; json?: boolean }) => {
      const applicationConfig = config();
      const environment = dependencies.env ?? process.env;
      const apiKey = resolveExplorerApiKey(environment);
      const generator = dependencies.strategyGenerator ?? (
        apiKey === undefined
          ? undefined
          : new CodexStrategyGenerator({ apiKey, env: environment })
      );
      const sink = dependencies.alertSink ?? createAlertSink({
        ...(applicationConfig.ntfyTopic === undefined
          ? {}
          : { ntfyTopic: applicationConfig.ntfyTopic }),
        fallbackPath: resolve(applicationConfig.projectRoot, "var/log/alerts.jsonl"),
        now,
      });
      const result = await withProcessLock(
        dependencies.lockPath ?? resolve(applicationConfig.projectRoot, "var/precos-pipeline.lock"),
        () => withDatabase((database) => runDaily({
          database,
          limit: Math.min(options.limit ?? applicationConfig.dailyPageCap, 2_000),
          dryRun: options.dryRun === true,
          concurrency: applicationConfig.pageConcurrency,
          rawHtmlRoot: resolve(applicationConfig.projectRoot, "data/raw-html"),
          retailerOptions,
          now,
          monitor: (runId) => monitorRun(runId, {
            database,
            ...(generator === undefined ? {} : { generator }),
            alertSink: sink,
            env: environment,
            now,
          }),
        })),
      );
      stdout(options.json === true
        ? `${JSON.stringify(result)}\n`
        : `daily: ${result.terminal}/${result.retailers} retailers terminal\n`);
    });

  command
    .command("heartbeat")
    .description("Inspect scheduled collection heartbeat health")
    .command("check")
    .option("--json", "emit only the JSON heartbeat check")
    .action(async (options: { json?: boolean }) => {
      const check = await withDatabase((database) =>
        checkHeartbeat(now(), latestSuccessfulHeartbeat(database, "collect")));
      if (check.stale) {
        const topic = config().ntfyTopic;
        const sink = dependencies.alertSink ?? createAlertSink({
          ...(topic === undefined ? {} : { ntfyTopic: topic }),
          fallbackPath: resolve(config().projectRoot, "var/log/alerts.jsonl"),
          now,
        });
        await sink.send({
          severity: "error",
          title: "Preço collection heartbeat stale",
          message: check.lastSuccessAt === null
            ? "No successful daily collection heartbeat is recorded"
            : "The latest successful daily collection heartbeat is older than 24 hours",
          details: check,
        });
      }
      stdout(options.json === true
        ? `${JSON.stringify(check)}\n`
        : `heartbeat: ${check.stale ? "STALE" : "FRESH"}\n`);
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
