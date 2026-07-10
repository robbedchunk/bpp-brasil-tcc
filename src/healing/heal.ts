import type Database from "better-sqlite3";

import {
  beginHealingEvent,
  claimStaleHealingEvent,
  consecutiveFailedHealingEvents,
  findRunHealthEvidence,
  finishHealingEvent,
  setRetailerDegraded,
} from "../db/repositories.js";
import {
  exploreRetailer,
  type ExploreRetailerDependencies,
  type ExplorationOutcome,
} from "../explorer/explore.js";
import type {
  StrategyGenerator,
  StrategyPurpose,
} from "../explorer/provider.js";
import type { AlertSink } from "../ops/alerts.js";
import { redactSandboxText } from "../explorer/package.js";
import type { ExtractionStrategy } from "../strategies/schema.js";
import type { ExtractionResult, ProductRef } from "../strategies/types.js";
import { classifyRunHealth } from "./classify-failure.js";

export interface HealRetailerDependencies {
  database: Database.Database;
  onsetRunId: string;
  generator?: StrategyGenerator;
  execute?: (
    strategy: ExtractionStrategy,
    ref: ProductRef,
  ) => Promise<ExtractionResult>;
  explore?: (
    retailerId: string,
    purpose: StrategyPurpose,
    dependencies: ExploreRetailerDependencies,
  ) => Promise<ExplorationOutcome>;
  alertSink?: AlertSink;
  now?: () => Date;
  maxAttempts?: number;
  eventBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  env?: NodeJS.ProcessEnv;
  openEventLeaseMs?: number;
}

export type HealingStatus =
  | "recovered"
  | "failed"
  | "provider_unavailable"
  | "deferred"
  | "in_progress";

export interface HealingOutcome {
  healingEventId: string;
  status: HealingStatus;
  attempts: number;
  activated: boolean;
  degraded: boolean;
  strategyId?: string;
  explorationRunId?: string;
}

function isDegraded(database: Database.Database, retailerId: string): boolean {
  const row = database.prepare(
    "SELECT degraded FROM retailers WHERE id = ?",
  ).get(retailerId) as { degraded: number } | undefined;
  if (row === undefined) throw new Error(`Retailer ${retailerId} was not found`);
  return row.degraded === 1;
}

export async function healRetailer(
  retailerId: string,
  purpose: StrategyPurpose,
  dependencies: HealRetailerDependencies,
): Promise<HealingOutcome> {
  const now = dependencies.now ?? (() => new Date());
  const evidence = findRunHealthEvidence(dependencies.database, dependencies.onsetRunId);
  if (evidence.run.retailerId !== retailerId) {
    throw new Error("Healing onset run belongs to a different retailer");
  }
  if (classifyRunHealth(evidence.run, evidence.failures) !== "drift") {
    throw new Error("Automatic healing requires a terminal drift-classified onset run");
  }
  const opened = beginHealingEvent(dependencies.database, {
    retailerId,
    purpose,
    onsetRunId: dependencies.onsetRunId,
    detectedAt: now().toISOString(),
  });
  if (!opened.created) {
    if (opened.event.status === "open") {
      const leaseMs = dependencies.openEventLeaseMs ?? 15 * 60 * 1_000;
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new RangeError("openEventLeaseMs must be a positive safe integer");
      }
      const claimedAt = now();
      const staleBefore = new Date(claimedAt.getTime() - leaseMs).toISOString();
      const claimed = claimStaleHealingEvent(
        dependencies.database,
        opened.event.id,
        staleBefore,
        claimedAt.toISOString(),
      );
      if (!claimed) {
        return {
          healingEventId: opened.event.id,
          status: "in_progress",
          attempts: opened.event.attempts,
          activated: false,
          degraded: isDegraded(dependencies.database, retailerId),
        };
      }
    }
    if (opened.event.status !== "open") return {
      healingEventId: opened.event.id,
      status: opened.event.status === "recovered"
        ? "recovered"
        : opened.event.status === "provider_unavailable"
          ? "provider_unavailable"
          : opened.event.status === "deferred"
            ? "deferred"
            : "failed",
      attempts: opened.event.attempts,
      activated: opened.event.status === "recovered",
      degraded: isDegraded(dependencies.database, retailerId),
      ...(opened.event.successorStrategyId === null
        ? {}
        : { strategyId: opened.event.successorStrategyId }),
    };
  }

  const failureSamples = evidence.failures.map((failure) => ({
    canonicalUrl: failure.canonicalUrl,
    category: failure.category,
    message: failure.message,
  }));
  let exploration: ExplorationOutcome;
  let explorationError: string | undefined;
  try {
    exploration = await (dependencies.explore ?? exploreRetailer)(
      retailerId,
      purpose,
      {
        database: dependencies.database,
        ...(dependencies.generator === undefined
          ? {}
          : { generator: dependencies.generator }),
        ...(dependencies.execute === undefined ? {} : { execute: dependencies.execute }),
        failureSamples,
        trigger: "healing",
        ...(dependencies.maxAttempts === undefined
          ? {}
          : { maxAttempts: dependencies.maxAttempts }),
        ...(dependencies.eventBudgetUsd === undefined
          ? {}
          : { eventBudgetUsd: dependencies.eventBudgetUsd }),
        ...(dependencies.monthlyBudgetUsd === undefined
          ? {}
          : { monthlyBudgetUsd: dependencies.monthlyBudgetUsd }),
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
        now,
      },
    );
  } catch (error) {
    explorationError = redactSandboxText(
      error instanceof Error ? error.message : String(error) || "Unknown error",
    );
    exploration = {
      explorationRunId: "unavailable",
      activated: false,
      attempts: 0,
      externalScore: null,
      outcome: "provider_failed",
      costUsd: 0,
    };
  }

  const status = exploration.activated
    ? "recovered" as const
    : exploration.outcome === "provider_unavailable"
      ? "provider_unavailable" as const
      : exploration.outcome === "budget_paused"
          || exploration.outcome === "budget_exhausted"
          || exploration.outcome === "insufficient_samples"
        ? "deferred" as const
        : "failed" as const;
  const finishedAt = now().toISOString();
  finishHealingEvent(dependencies.database, {
    healingEventId: opened.event.id,
    status,
    attempts: exploration.attempts,
    finishedAt,
    ...(exploration.strategyId === undefined
      ? {}
      : { successorStrategyId: exploration.strategyId }),
    details: {
      explorationRunId: exploration.explorationRunId,
      explorationOutcome: exploration.outcome,
      externalScore: exploration.externalScore,
      costUsd: exploration.costUsd,
      ...(explorationError === undefined ? {} : { error: explorationError.slice(0, 2_000) }),
    },
  });

  let degraded = isDegraded(dependencies.database, retailerId);
  if (status === "recovered") {
    setRetailerDegraded(dependencies.database, retailerId, false, undefined, finishedAt);
    degraded = false;
  } else if (status === "failed") {
    const consecutive = consecutiveFailedHealingEvents(
      dependencies.database,
      retailerId,
      purpose,
    );
    if (consecutive >= 3) {
      setRetailerDegraded(
        dependencies.database,
        retailerId,
        true,
        `${purpose} regeneration failed for ${consecutive} consecutive events`,
        finishedAt,
      );
      degraded = true;
      await dependencies.alertSink?.send({
        severity: "error",
        title: "Retailer strategy healing degraded",
        message: "Three consecutive regeneration events failed; this retailer alone was degraded",
        details: { retailerId, purpose, consecutiveEvents: consecutive },
      });
    }
  } else {
    await dependencies.alertSink?.send({
      severity: "warning",
      title: "Retailer strategy healing pending",
      message: status === "provider_unavailable"
        ? "Explorer credentials are unavailable; the active strategy was preserved"
        : "Healing was deferred by validation-data or budget controls; the active strategy was preserved",
      details: {
        retailerId,
        purpose,
        onsetRunId: dependencies.onsetRunId,
        status,
      },
    });
  }

  return {
    healingEventId: opened.event.id,
    status,
    attempts: exploration.attempts,
    activated: exploration.activated,
    degraded,
    explorationRunId: exploration.explorationRunId,
    ...(exploration.strategyId === undefined ? {} : { strategyId: exploration.strategyId }),
  };
}
