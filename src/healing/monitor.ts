import type Database from "better-sqlite3";

import { findRunHealthEvidence } from "../db/repositories.js";
import type { StrategyGenerator } from "../explorer/provider.js";
import type { AlertSink } from "../ops/alerts.js";
import type { ExtractionStrategy } from "../strategies/schema.js";
import type { ExtractionResult, ProductRef } from "../strategies/types.js";
import { classifyRunHealth, type RunHealth } from "./classify-failure.js";
import {
  healRetailer,
  type HealingOutcome,
  type HealRetailerDependencies,
} from "./heal.js";

export interface MonitorRunDependencies {
  database: Database.Database;
  generator?: StrategyGenerator;
  execute?: (
    strategy: ExtractionStrategy,
    ref: ProductRef,
  ) => Promise<ExtractionResult>;
  heal?: (
    retailerId: string,
    purpose: "extraction",
    dependencies: HealRetailerDependencies,
  ) => Promise<HealingOutcome>;
  alertSink?: AlertSink;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface MonitorDecision {
  runId: string;
  retailerId: string;
  health: RunHealth;
  action: "none" | "not_terminal" | "alerted" | "healed" | "healing_pending";
  healing?: HealingOutcome;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "partial", "failed"]);

export async function monitorRun(
  runId: string,
  dependencies: MonitorRunDependencies,
): Promise<MonitorDecision> {
  const evidence = findRunHealthEvidence(dependencies.database, runId);
  if (
    evidence.run.finishedAt === null
    || !TERMINAL_RUN_STATUSES.has(evidence.run.status)
  ) {
    return {
      runId,
      retailerId: evidence.run.retailerId,
      health: "mixed",
      action: "not_terminal",
    };
  }
  const health = classifyRunHealth(evidence.run, evidence.failures);
  if (health === "healthy") {
    return {
      runId,
      retailerId: evidence.run.retailerId,
      health,
      action: "none",
    };
  }
  if (health === "blocking" || health === "mixed") {
    await dependencies.alertSink?.send({
      severity: "warning",
      title: health === "blocking"
        ? "Retailer collection is blocked"
        : "Retailer collection has mixed access evidence",
      message: "Automatic strategy generation was not invoked to avoid wasted model spend",
      details: {
        runId,
        retailerId: evidence.run.retailerId,
        health,
        attempted: evidence.run.attempted,
        ok: evidence.run.ok,
        failed: evidence.run.failed,
      },
    });
    return {
      runId,
      retailerId: evidence.run.retailerId,
      health,
      action: "alerted",
    };
  }

  const healing = await (dependencies.heal ?? healRetailer)(
    evidence.run.retailerId,
    "extraction",
    {
      database: dependencies.database,
      onsetRunId: runId,
      ...(dependencies.generator === undefined
        ? {}
        : { generator: dependencies.generator }),
      ...(dependencies.execute === undefined ? {} : { execute: dependencies.execute }),
      ...(dependencies.alertSink === undefined
        ? {}
        : { alertSink: dependencies.alertSink }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
    },
  );
  return {
    runId,
    retailerId: evidence.run.retailerId,
    health,
    action: healing.status === "recovered" ? "healed" : "healing_pending",
    healing,
  };
}
