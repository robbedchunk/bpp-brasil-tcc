import type Database from "better-sqlite3";

import {
  beginHealingEvent,
  findRunHealthEvidence,
  type StrategyPurpose,
} from "../db/repositories.js";
import type { StrategyGenerator } from "../explorer/provider.js";
import type { AlertSink } from "../ops/alerts.js";
import type { ExtractionStrategy } from "../strategies/schema.js";
import type { ExtractionResult, ProductRef } from "../strategies/types.js";
import { classifyRunHealth, type RunHealth } from "./classify-failure.js";
import type { HealingOutcome, HealRetailerDependencies } from "./heal.js";

export interface MonitorRunDependencies {
  database: Database.Database;
  generator?: StrategyGenerator;
  execute?: (
    strategy: ExtractionStrategy,
    ref: ProductRef,
  ) => Promise<ExtractionResult>;
  heal?: (
    retailerId: string,
    purpose: StrategyPurpose,
    dependencies: HealRetailerDependencies,
  ) => Promise<HealingOutcome>;
  alertSink?: AlertSink;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface MonitorDecision {
  runId: string;
  retailerId: string;
  purpose: StrategyPurpose;
  health: RunHealth;
  action: "none" | "not_terminal" | "alerted" | "queued" | "healing_pending";
  healing?: HealingOutcome;
  healingEventId?: string;
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
      purpose: evidence.run.purpose,
      health: "mixed",
      action: "not_terminal",
    };
  }
  const health = classifyRunHealth(evidence.run, evidence.failures);
  if (health === "healthy") {
    return {
      runId,
      retailerId: evidence.run.retailerId,
      purpose: evidence.run.purpose,
      health,
      action: "none",
    };
  }
  if (health === "blocking" || health === "mixed") {
    const workload = evidence.run.purpose === "discovery"
      ? "discovery"
      : "collection";
    await dependencies.alertSink?.send({
      severity: "warning",
      title: health === "blocking"
        ? `Retailer ${workload} is blocked`
        : `Retailer ${workload} has mixed access evidence`,
      message: "Automatic strategy generation was not invoked to avoid wasted model spend",
      details: {
        runId,
        retailerId: evidence.run.retailerId,
        purpose: evidence.run.purpose,
        stage: evidence.run.stage,
        health,
        attempted: evidence.run.attempted,
        ok: evidence.run.ok,
        failed: evidence.run.failed,
        planned: evidence.run.planned,
        skipped: evidence.run.skipped,
        stoppedForBlocking: evidence.run.stoppedForBlocking,
      },
    });
    return {
      runId,
      retailerId: evidence.run.retailerId,
      purpose: evidence.run.purpose,
      health,
      action: "alerted",
    };
  }

  const opened = beginHealingEvent(dependencies.database, {
    retailerId: evidence.run.retailerId,
    purpose: evidence.run.purpose,
    onsetRunId: runId,
    detectedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    queued: true,
  });
  return {
    runId,
    retailerId: evidence.run.retailerId,
    purpose: evidence.run.purpose,
    health,
    action: opened.created ? "queued" : "healing_pending",
    healingEventId: opened.event.id,
  };
}
