#!/usr/bin/env node

import { relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import type Database from "better-sqlite3";

import { MAX_FOOD_CATALOG_PRODUCTS } from "./catalog/scope.js";
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
  latestTerminalStrategyRunId,
  readStatusReport,
  type StatusReport,
} from "./db/repositories.js";
import {
  reconcileInterruptedPipelineRuns,
  reconcileInterruptedStandaloneExplorations,
} from "./db/runtime-reconciliation.js";
import { runCollection } from "./pipeline/collect.js";
import {
  runReplayReextraction,
  type ReplayReextractionSummary,
  type RunReplayReextractionOptions,
} from "./collection/reextract.js";
import {
  runDaily as runDailyPipeline,
  type DailyPipelineDependencies,
  type DailySummary,
} from "./pipeline/daily.js";
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
import { ProcessLockError, withProcessLock } from "./ops/lock.js";
import { readScheduledDailyInvocation } from "./ops/systemd-provenance.js";
import {
  BudgetGuard,
  reconcileSynchronousClassificationReservations,
} from "./ops/budget.js";
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
  healPendingEvents as runHealPendingEvents,
  healRetailer as runHealRetailer,
  type HealingWorkerSummary,
  type HealingOutcome,
  type HealPendingEventsDependencies,
  type HealRetailerDependencies,
} from "./healing/heal.js";
import { monitorRun } from "./healing/monitor.js";
import { buildDailyIndex } from "./index/aggregate.js";
import {
  assertSafeOutputPath,
  OfficialSourceUnavailableError,
  exportResearchData as runExportResearchData,
} from "./index/export.js";
import { OfficialSidraClient } from "./index/sidra.js";
import { strictDay } from "./index/relatives.js";
import type {
  ExportResearchFunction,
  SidraClient,
} from "./index/types.js";

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
  indexLockPath?: string;
  sidraClient?: SidraClient;
  exportResearchData?: ExportResearchFunction;
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
  healPendingEvents?: (
    dependencies: HealPendingEventsDependencies,
  ) => Promise<HealingWorkerSummary>;
  monitorRun?: typeof monitorRun;
  runDiscovery?: (
    retailerId: string,
    options: PipelineCliOptions,
  ) => Promise<RunSummary>;
  runDaily?: (
    dependencies: DailyPipelineDependencies,
  ) => Promise<DailySummary>;
  runCollection?: (
    retailerId: string,
    options: PipelineCliOptions,
  ) => Promise<RunSummary>;
  replayReextract?: (
    options: RunReplayReextractionOptions,
  ) => Promise<ReplayReextractionSummary>;
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
    retailer.yesterdayRun?.collectionDay ?? report.reportDay,
    String(retailer.yesterdayRun?.attempted ?? 0),
    String(retailer.yesterdayRun?.ok ?? 0),
    String(retailer.yesterdayRun?.failed ?? 0),
    retailer.yesterdayRun === null
      ? "-"
      : `${(retailer.yesterdayRun.successRate * 100).toFixed(1)}%`,
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
  const pipelineLockPath = (): string =>
    dependencies.lockPath ?? resolve(config().projectRoot, "var/precos-pipeline.lock");
  const explorerLockPath = (): string =>
    dependencies.lockPath ?? resolve(config().projectRoot, "var/precos-explorer.lock");
  const withHealingLocks = async <T>(operation: () => Promise<T>): Promise<T> => {
    const pipelinePath = pipelineLockPath();
    const explorerPath = explorerLockPath();
    return withProcessLock(pipelinePath, () =>
      pipelinePath === explorerPath
        ? operation()
        : withProcessLock(explorerPath, operation));
  };
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
    return parsed;
  };
  const positiveLimitAtTwoThousand = (value: string): number =>
    Math.min(positiveLimit(value), 2_000);
  const pipelineCommand = (
    name: "discover" | "collect",
    description: string,
  ): void => {
    command
      .command(name)
      .description(description)
      .option("--retailer <id>", "run only one registered retailer")
      .option(
        "--limit <count>",
        name === "discover"
          ? "maximum discovered products, capped at 3000"
          : "maximum product attempts, capped at 2000",
        positiveLimit,
      )
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
          if (options.dryRun !== true) {
            reconcileInterruptedPipelineRuns(database, now().toISOString());
          }
          const retailerIds = options.retailer === undefined
            ? activeRetailerIds(database)
            : [options.retailer];
          const limit = name === "discover"
            ? Math.min(options.limit ?? MAX_FOOD_CATALOG_PRODUCTS, MAX_FOOD_CATALOG_PRODUCTS)
            : Math.min(options.limit ?? config().dailyPageCap, 2_000);
          const pipelineOptions = { limit, dryRun: options.dryRun === true };
          const results: RunSummary[] = [];
          for (const retailerId of retailerIds) {
            if (name === "discover") {
              const summary =
                dependencies.runDiscovery === undefined
                  ? await runDiscovery(retailerId, {
                      database,
                      ...pipelineOptions,
                      logDirectory: resolve(config().projectRoot, "var/log/runs"),
                      ...retailerOptions(retailerId),
                    })
                  : await dependencies.runDiscovery(retailerId, pipelineOptions);
              results.push(summary);
              if (!summary.dryRun) {
                const applicationConfig = config();
                const sink = dependencies.alertSink ?? createAlertSink({
                  ...(applicationConfig.ntfyTopic === undefined
                    ? {}
                    : { ntfyTopic: applicationConfig.ntfyTopic }),
                  fallbackPath: resolve(applicationConfig.projectRoot, "var/log/alerts.jsonl"),
                  now,
                });
                await (dependencies.monitorRun ?? monitorRun)(summary.id, {
                  database,
                  alertSink: sink,
                  env: dependencies.env ?? process.env,
                  now,
                });
              }
            } else {
              results.push(
                dependencies.runCollection === undefined
                  ? await runCollection(retailerId, {
                      database,
                      ...pipelineOptions,
                      concurrency: config().pageConcurrency,
                      rawHtmlRoot: resolve(config().projectRoot, "data/raw-html"),
                      logDirectory: resolve(config().projectRoot, "var/log/runs"),
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
        () => withDatabase((database) => {
          reconcileInterruptedStandaloneExplorations(database, now().toISOString());
          return (dependencies.exploreRetailer ?? runExploreRetailer)(
            options.retailer,
            options.purpose,
            {
              database,
              ...(generator === undefined ? {} : { generator }),
              env: environment,
              now,
            },
          );
        }),
      );
      if (!outcome.activated && (
        outcome.outcome === "provider_unavailable"
        || outcome.outcome === "budget_paused"
        || outcome.outcome === "budget_exhausted"
        || outcome.outcome === "provider_failed"
        || outcome.outcome === "unauditable_spend"
      ) && outcome.alerted !== true) {
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
    .description("Regenerate a drifted discovery or extraction strategy through trusted exploration")
    .option("--retailer <id>", "registered retailer ID or pending-event filter")
    .option(
      "--purpose <purpose>",
      "strategy purpose for direct healing: discovery or extraction",
      strategyPurpose,
      "extraction",
    )
    .option("--run <id>", "terminal strategy run that detected drift")
    .option("--pending", "process queued healing events")
    .option("--json", "emit only JSON")
    .action(async (options: {
      retailer?: string;
      purpose: StrategyPurpose;
      run?: string;
      pending?: boolean;
      json?: boolean;
    }) => {
      if (options.pending === true && options.run !== undefined) {
        throw new Error("--run cannot be combined with --pending");
      }
      if (options.pending !== true && options.retailer === undefined) {
        throw new Error("--retailer is required unless --pending is used");
      }
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
      const outcome: HealingOutcome | HealingWorkerSummary = await withHealingLocks(
        () => withDatabase<HealingOutcome | HealingWorkerSummary>((database) => {
          const reconciliationTime = now().toISOString();
          reconcileInterruptedPipelineRuns(database, reconciliationTime);
          reconcileInterruptedStandaloneExplorations(database, reconciliationTime);
          if (options.pending === true) {
            return (dependencies.healPendingEvents ?? runHealPendingEvents)({
              database,
              ...(options.retailer === undefined ? {} : { retailerId: options.retailer }),
              ...(generator === undefined ? {} : { generator }),
              alertSink: sink,
              env: environment,
              now,
              replayRoot: resolve(applicationConfig.projectRoot, "data/raw-html"),
            });
          }
          const retailerId = options.retailer!;
          const onsetRunId = options.run
            ?? latestTerminalStrategyRunId(database, retailerId, options.purpose);
          if (onsetRunId === null) {
            throw new Error(
              `No terminal ${options.purpose} run exists for ${retailerId}`,
            );
          }
          return (dependencies.healRetailer ?? runHealRetailer)(
            retailerId,
            options.purpose,
            {
              database,
              onsetRunId,
              ...(generator === undefined ? {} : { generator }),
              alertSink: sink,
              env: environment,
              now,
              replayRoot: resolve(applicationConfig.projectRoot, "data/raw-html"),
            },
          );
        }),
      );
      stdout(options.json === true
        ? `${JSON.stringify(outcome)}\n`
        : options.pending === true
          ? `heal pending: ${(outcome as HealingWorkerSummary).processed} event(s) processed\n`
          : `heal ${options.retailer}/${options.purpose}: ${(outcome as HealingOutcome).status}; ${(outcome as HealingOutcome).attempts} attempt(s)\n`);
    });

  command
    .command("replay-reextract")
    .description("Privately re-extract one verified replay and append an audit result")
    .requiredOption("--observation <id>", "successful observation with replay evidence")
    .option("--json", "emit only the structured non-public result")
    .action(async (options: { observation: string; json?: boolean }) => {
      const applicationConfig = config();
      const result = await withProcessLock(
        pipelineLockPath(),
        () => withDatabase((database) => {
          reconcileInterruptedPipelineRuns(database, now().toISOString());
          return (dependencies.replayReextract ?? runReplayReextraction)({
            database,
            observationId: options.observation,
            replayRoot: resolve(applicationConfig.projectRoot, "data/raw-html"),
            now,
          });
        }),
      );
      stdout(options.json === true
        ? `${JSON.stringify(result)}\n`
        : `replay re-extraction ${result.id}: ${result.status}\n`);
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
    .option(
      "--batch-size <count>",
      "classification batch size",
      positiveLimitAtTwoThousand,
      50,
    )
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
          if (options.dryRun !== true) {
            reconcileSynchronousClassificationReservations(
              database,
              now().toISOString(),
            );
          }
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

  const positiveVersion = (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("--classification-version must be a positive integer");
    }
    return parsed;
  };
  const indexDay = (value: string): string => strictDay(value);
  command
    .command("index")
    .description("Calculate and optionally snapshot the experimental food-at-home index")
    .option("--export", "publish an immutable CSV snapshot")
    .option("--output <directory>", "snapshot output directory under the project root")
    .option("--through <YYYY-MM-DD>", "inclusive São Paulo collection day", indexDay)
    .option(
      "--classification-version <number>",
      "use exactly one append-only classification version",
      positiveVersion,
    )
    .option("--require-official", "fail if the official SIDRA pull is unavailable")
    .option("--json", "emit only JSON")
    .action(async (options: {
      export?: boolean;
      output?: string;
      through?: string;
      classificationVersion?: number;
      requireOfficial?: boolean;
      json?: boolean;
    }) => {
      const applicationConfig = config();
      const configuredOutput = resolve(
        applicationConfig.projectRoot,
        options.output ?? "data/exports",
      );
      const relativeOutput = relative(applicationConfig.projectRoot, configuredOutput);
      if (
        relativeOutput === ".."
        || relativeOutput.startsWith(`..${sep}`)
        || relativeOutput.startsWith(sep)
      ) {
        throw new Error("--output must stay inside PROJECT_ROOT");
      }
      if (options.export === true) await assertSafeOutputPath(configuredOutput);
      const result = await withProcessLock(
        dependencies.indexLockPath
          ?? resolve(applicationConfig.projectRoot, "var/precos-index.lock"),
        () => withDatabase(async (database) => {
          if (options.export !== true) {
            const series = buildDailyIndex(database, {
              ...(options.through === undefined ? {} : { throughDay: options.through }),
              ...(options.classificationVersion === undefined
                ? {}
                : { classificationVersion: options.classificationVersion }),
            });
            return {
              status: series.aggregate.some((point) => point.dailyRelative !== null)
                ? "complete"
                : "no_index_data",
              methodVersion: series.methodVersion,
              throughDay: series.throughDay,
              productRelatives: series.productRelatives.length,
              aggregatePoints: series.aggregate.length,
            };
          }
          const sink = dependencies.alertSink ?? createAlertSink({
            ...(applicationConfig.ntfyTopic === undefined
              ? {}
              : { ntfyTopic: applicationConfig.ntfyTopic }),
            fallbackPath: resolve(applicationConfig.projectRoot, "var/log/alerts.jsonl"),
            now,
          });
          try {
            return await (dependencies.exportResearchData ?? runExportResearchData)(database, {
              outputRoot: configuredOutput,
              now,
              sidraClient: dependencies.sidraClient ?? new OfficialSidraClient(),
              alertSink: sink,
              requireOfficial: options.requireOfficial === true,
              ...(options.through === undefined ? {} : { throughDay: options.through }),
              ...(options.classificationVersion === undefined
                ? {}
                : { classificationVersion: options.classificationVersion }),
            });
          } catch (error) {
            if (error instanceof OfficialSourceUnavailableError) {
              stdout(options.json === true
                ? `${JSON.stringify(error.manifest)}\n`
                : `index: ${error.manifest.status}\n`);
            }
            throw error;
          }
        }),
      );
      stdout(options.json === true
        ? `${JSON.stringify(result)}\n`
        : `index: ${result.status}\n`);
    });

  command
    .command("daily")
    .description("Run daily collection for every active retailer")
    .option(
      "--limit <count>",
      "maximum products per retailer, capped at 2000",
      positiveLimitAtTwoThousand,
    )
    .option("--dry-run", "report a persisted-data plan without network or writes")
    .option("--json", "emit only the JSON summary")
    .action(async (options: { limit?: number; dryRun?: boolean; json?: boolean }) => {
      const applicationConfig = config();
      const environment = dependencies.env ?? process.env;
      const scheduledInvocation = readScheduledDailyInvocation(environment);
      const sink = dependencies.alertSink ?? createAlertSink({
        ...(applicationConfig.ntfyTopic === undefined
          ? {}
          : { ntfyTopic: applicationConfig.ntfyTopic }),
        fallbackPath: resolve(applicationConfig.projectRoot, "var/log/alerts.jsonl"),
        now,
      });
      const result = await withProcessLock(
        pipelineLockPath(),
        () => withDatabase((database) => {
          if (options.dryRun !== true) {
            reconcileInterruptedPipelineRuns(database, now().toISOString());
          }
          return (dependencies.runDaily ?? runDailyPipeline)({
            database,
          ...(scheduledInvocation === null ? {} : { scheduledInvocation }),
          limit: Math.min(options.limit ?? applicationConfig.dailyPageCap, 2_000),
          dryRun: options.dryRun === true,
          concurrency: applicationConfig.pageConcurrency,
          rawHtmlRoot: resolve(applicationConfig.projectRoot, "data/raw-html"),
          logDirectory: resolve(applicationConfig.projectRoot, "var/log/runs"),
          retailerOptions,
          now,
          monitor: (runId) => monitorRun(runId, {
            database,
            alertSink: sink,
            env: environment,
            now,
          }),
          reportOperationalFailure: async (failure) => sink.send({
            severity: "error",
            title: failure.kind === "collection"
              ? "Retailer collection orchestration failed"
              : "Post-collection monitor failed",
            message: failure.kind === "collection"
              ? "Later retailers will still be attempted; the daily service will finish nonzero"
              : "Collection completed, but drift monitoring did not durably complete",
            details: failure,
          }),
          });
        }),
      );
      stdout(options.json === true
        ? `${JSON.stringify(result)}\n`
        : `daily: ${result.terminal}/${result.retailers} retailers terminal\n`);
      if (options.dryRun !== true && result.status !== "completed") {
        throw new Error(
          `Daily pipeline finished ${result.status}: `
          + `${result.retailerFailures.length} retailer failure(s), `
          + `${result.monitorFailedRunIds.length} monitor failure(s)`,
        );
      }
    });

  command
    .command("heartbeat")
    .description("Inspect scheduled collection heartbeat health")
    .command("check")
    .option("--json", "emit only the JSON heartbeat check")
    .action(async (options: { json?: boolean }) => {
      const check = await withDatabase((database) =>
        checkHeartbeat(now(), latestSuccessfulHeartbeat(database, "collect", { scheduledOnly: true })));
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

function invokedAsMain(invokedPath: string | undefined): boolean {
  if (invokedPath === undefined) return false;
  try {
    return realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain(process.argv[1])) {
  try {
    loadEnvironmentFile();
    await buildCli().parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`precos: ${message}\n`);
    process.exitCode = error instanceof ProcessLockError ? error.exitCode : 1;
  }
}
