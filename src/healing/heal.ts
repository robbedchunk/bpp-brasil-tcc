import type Database from "better-sqlite3";

import { resolve } from "node:path";

import { readReplayPayload } from "../collection/replay.js";
import {
  beginHealingEvent,
  claimStaleHealingEvent,
  consecutiveFailedHealingEvents,
  findRunHealthEvidence,
  finishHealingWorkerFailureIfSafe,
  finishHealingEvent,
  listPriorSuccessfulReplayEvidence,
  listPendingHealingEvents,
  promoteQueuedHealingEvent,
  reconcileHealingExploration,
  recordHealingWorkerError,
  setRetailerDegraded,
} from "../db/repositories.js";
import {
  exploreRetailer,
  ExplorationEvidenceError,
  type CandidateValidator,
  type ExploreRetailerDependencies,
  type ExplorationOutcome,
} from "../explorer/explore.js";
import type {
  StrategyGenerator,
  StrategyPurpose,
} from "../explorer/provider.js";
import type { AlertSink } from "../ops/alerts.js";
import {
  redactSandboxText,
  representativeFailureSamples,
  type SandboxSample,
} from "../explorer/package.js";
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
  validateCandidate?: CandidateValidator;
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
  replayRoot?: string;
  readReplay?: typeof readReplayPayload;
}

export type HealingStatus =
  | "recovered"
  | "failed"
  | "provider_unavailable"
  | "deferred"
  | "superseded"
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

export class HealingRecoveryPendingError extends Error {
  readonly healingEventId: string;

  constructor(
    message: string,
    healingEventId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HealingRecoveryPendingError";
    this.healingEventId = healingEventId;
  }
}

export type HealPendingEventsDependencies = Omit<
  HealRetailerDependencies,
  "onsetRunId"
> & { retailerId?: string };

export interface HealingWorkerSummary {
  queued: number;
  processed: number;
  recovered: number;
  failed: number;
  deferred: number;
  providerUnavailable: number;
  superseded: number;
  inProgress: number;
  workerErrors: number;
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
  if (evidence.run.purpose !== purpose) {
    throw new Error("Healing purpose does not match the onset run strategy");
  }
  if (
    evidence.run.finishedAt === null
    || !["completed", "partial", "failed"].includes(evidence.run.status)
  ) {
    throw new Error("Automatic healing requires a terminal onset run");
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
  if (opened.created && opened.event.status === "queued") {
    return {
      healingEventId: opened.event.id,
      status: "in_progress",
      attempts: 0,
      activated: false,
      degraded: isDegraded(dependencies.database, retailerId),
    };
  }
  if (!opened.created) {
    if (opened.event.onsetRunId !== dependencies.onsetRunId) {
      return {
        healingEventId: opened.event.id,
        status: "in_progress",
        attempts: opened.event.attempts,
        activated: false,
        degraded: isDegraded(dependencies.database, retailerId),
      };
    }
    if (opened.event.status === "queued") {
      return {
        healingEventId: opened.event.id,
        status: "in_progress",
        attempts: opened.event.attempts,
        activated: false,
        degraded: isDegraded(dependencies.database, retailerId),
      };
    }
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
            : opened.event.status === "superseded"
              ? "superseded"
            : "failed",
      attempts: opened.event.attempts,
      activated: opened.event.status === "recovered",
      degraded: isDegraded(dependencies.database, retailerId),
      ...(opened.event.successorStrategyId === null
        ? {}
        : { strategyId: opened.event.successorStrategyId }),
    };
  }

  let reconciled: ReturnType<typeof reconcileHealingExploration>;
  try {
    reconciled = reconcileHealingExploration(dependencies.database, {
      healingEventId: opened.event.id,
      finishedAt: now().toISOString(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error) || "unknown error";
    throw new HealingRecoveryPendingError(
      `Healing exploration reconciliation remains pending: ${reason}`,
      opened.event.id,
      { cause: error },
    );
  }
  if (reconciled !== null) {
    let degraded = isDegraded(dependencies.database, retailerId);
    if (reconciled.status === "recovered" && degraded) {
      degraded = setRetailerDegraded(
        dependencies.database,
        retailerId,
        false,
        undefined,
        now().toISOString(),
        opened.event.id,
      );
    } else if (reconciled.status === "failed") {
      const consecutive = consecutiveFailedHealingEvents(
        dependencies.database,
        retailerId,
        purpose,
      );
      if (consecutive >= 3 && !degraded) {
        setRetailerDegraded(
          dependencies.database,
          retailerId,
          true,
          `${purpose} regeneration failed for ${consecutive} consecutive events`,
          now().toISOString(),
          opened.event.id,
        );
        degraded = true;
        await dependencies.alertSink?.send({
          severity: "error",
          title: "Retailer strategy healing degraded",
          message: "Three consecutive regeneration events failed; this retailer alone was degraded",
          details: { retailerId, purpose, consecutiveEvents: consecutive, reconciled: true },
        });
      }
    }
    return {
      healingEventId: opened.event.id,
      status: reconciled.status,
      attempts: reconciled.attempts,
      activated: reconciled.status === "recovered",
      degraded,
      explorationRunId: reconciled.explorationRunId,
    };
  }

  const active = dependencies.database.prepare(
    `SELECT id FROM strategies
     WHERE retailer_id = ? AND purpose = ? AND active = 1`,
  ).get(retailerId, purpose) as { id: string } | undefined;
  if (active?.id !== opened.event.previousStrategyId) {
    const finishedAt = now().toISOString();
    finishHealingEvent(dependencies.database, {
      healingEventId: opened.event.id,
      status: "superseded",
      attempts: opened.event.attempts,
      finishedAt,
      details: {
        reason: "onset strategy is no longer active",
        onsetRunId: opened.event.onsetRunId,
        previousStrategyId: opened.event.previousStrategyId,
        activeStrategyId: active?.id ?? null,
      },
    });
    return {
      healingEventId: opened.event.id,
      status: "superseded",
      attempts: opened.event.attempts,
      activated: false,
      degraded: isDegraded(dependencies.database, retailerId),
    };
  }

  const failureSamples = representativeFailureSamples(evidence.failures.map((failure) => ({
    canonicalUrl: failure.canonicalUrl,
    category: failure.category,
    message: failure.message,
  })));
  const verifiedReplaySamples: SandboxSample[] = [];
  let rejectedReplaySamples = 0;
  let archiveReplaySamplesUsed = 0;
  let archiveReplaySamplesRejected = 0;
  const replayRoot = resolve(dependencies.replayRoot ?? "data/raw-html");
  for (const failure of evidence.failures) {
    if (failure.canonicalUrl === null || failure.replay === null) continue;
    try {
      const replay = await (dependencies.readReplay ?? readReplayPayload)(
        replayRoot,
        failure.replay,
      );
      verifiedReplaySamples.push({
        canonicalUrl: failure.canonicalUrl,
        body: replay.body,
        capture: "current",
        collectionDay: evidence.run.collectionDay,
      });
    } catch {
      // A missing or tampered private artifact is never handed to the explorer.
      rejectedReplaySamples += 1;
    }
  }
  const archiveEvidence = listPriorSuccessfulReplayEvidence(dependencies.database, {
    retailerId,
    beforeCollectionDay: evidence.run.collectionDay,
    canonicalUrls: evidence.failures.flatMap((failure) =>
      failure.canonicalUrl === null ? [] : [failure.canonicalUrl]),
    limit: 5,
  });
  for (const archive of archiveEvidence) {
    try {
      const replay = await (dependencies.readReplay ?? readReplayPayload)(
        replayRoot,
        archive.replay,
      );
      verifiedReplaySamples.push({
        canonicalUrl: archive.canonicalUrl,
        body: replay.body,
        capture: "archive",
        collectionDay: archive.collectionDay,
      });
      archiveReplaySamplesUsed += 1;
    } catch {
      rejectedReplaySamples += 1;
      archiveReplaySamplesRejected += 1;
    }
  }
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
        ...(dependencies.validateCandidate === undefined
          ? {}
          : { validateCandidate: dependencies.validateCandidate }),
        failureSamples,
        failureSampleTotal: evidence.failures.length,
        ...(verifiedReplaySamples.length === 0
          ? {}
          : { sandboxSamples: verifiedReplaySamples }),
        trigger: "healing",
        healingEventId: opened.event.id,
        ...(dependencies.alertSink === undefined
          ? {}
          : { alertSink: dependencies.alertSink }),
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
    if (error instanceof ExplorationEvidenceError && error.terminalCommitFailed) {
      throw error;
    }
    explorationError = redactSandboxText(
      error instanceof Error ? error.message : String(error) || "Unknown error",
    );
    exploration = error instanceof ExplorationEvidenceError
      ? error.outcome
      : {
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
      replaySamplesUsed: verifiedReplaySamples.length,
      replaySamplesRejected: rejectedReplaySamples,
      archiveReplaySamplesUsed,
      archiveReplaySamplesRejected,
      ...(explorationError === undefined ? {} : { error: explorationError.slice(0, 2_000) }),
    },
  });

  let degraded = isDegraded(dependencies.database, retailerId);
  if (status === "recovered") {
    degraded = setRetailerDegraded(
      dependencies.database,
      retailerId,
      false,
      undefined,
      finishedAt,
      opened.event.id,
    );
  } else if (status === "failed") {
    const consecutive = consecutiveFailedHealingEvents(
      dependencies.database,
      retailerId,
      purpose,
    );
    if (consecutive >= 3 && !degraded) {
      setRetailerDegraded(
        dependencies.database,
        retailerId,
        true,
        `${purpose} regeneration failed for ${consecutive} consecutive events`,
        finishedAt,
        opened.event.id,
      );
      degraded = true;
      await dependencies.alertSink?.send({
        severity: "error",
        title: "Retailer strategy healing degraded",
        message: "Three consecutive regeneration events failed; this retailer alone was degraded",
        details: { retailerId, purpose, consecutiveEvents: consecutive },
      });
    }
  } else if (exploration.alerted !== true) {
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

export async function healPendingEvents(
  dependencies: HealPendingEventsDependencies,
): Promise<HealingWorkerSummary> {
  const events = listPendingHealingEvents(dependencies.database, dependencies.retailerId);
  const summary: HealingWorkerSummary = {
    queued: events.length,
    processed: 0,
    recovered: 0,
    failed: 0,
    deferred: 0,
    providerUnavailable: 0,
    superseded: 0,
    inProgress: 0,
    workerErrors: 0,
  };
  const countOutcome = (status: HealingStatus): void => {
    if (status === "in_progress") summary.inProgress += 1;
    else {
      summary.processed += 1;
      if (status === "recovered") summary.recovered += 1;
      else if (status === "provider_unavailable") summary.providerUnavailable += 1;
      else if (status === "deferred") summary.deferred += 1;
      else if (status === "superseded") summary.superseded += 1;
      else summary.failed += 1;
    }
  };
  for (const event of events) {
    try {
      if (event.status === "queued" && !promoteQueuedHealingEvent(
        dependencies.database,
        event.id,
      )) {
        countOutcome("in_progress");
        continue;
      }
      if (event.onsetRunId === null) {
        finishHealingEvent(dependencies.database, {
          healingEventId: event.id,
          status: "superseded",
          attempts: event.attempts,
          finishedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          details: { reason: "queued event has no onset run" },
        });
        countOutcome("superseded");
        continue;
      }
      const outcome = await healRetailer(event.retailerId, event.purpose, {
        database: dependencies.database,
        onsetRunId: event.onsetRunId,
        ...(dependencies.generator === undefined ? {} : { generator: dependencies.generator }),
        ...(dependencies.execute === undefined ? {} : { execute: dependencies.execute }),
        ...(dependencies.validateCandidate === undefined
          ? {}
          : { validateCandidate: dependencies.validateCandidate }),
        ...(dependencies.explore === undefined ? {} : { explore: dependencies.explore }),
        ...(dependencies.alertSink === undefined ? {} : { alertSink: dependencies.alertSink }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.maxAttempts === undefined ? {} : { maxAttempts: dependencies.maxAttempts }),
        ...(dependencies.eventBudgetUsd === undefined
          ? {}
          : { eventBudgetUsd: dependencies.eventBudgetUsd }),
        ...(dependencies.monthlyBudgetUsd === undefined
          ? {}
          : { monthlyBudgetUsd: dependencies.monthlyBudgetUsd }),
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
        ...(dependencies.openEventLeaseMs === undefined
          ? {}
          : { openEventLeaseMs: dependencies.openEventLeaseMs }),
        ...(dependencies.replayRoot === undefined
          ? {}
          : { replayRoot: dependencies.replayRoot }),
        ...(dependencies.readReplay === undefined
          ? {}
          : { readReplay: dependencies.readReplay }),
      });
      countOutcome(outcome.status);
    } catch (error) {
      summary.workerErrors += 1;
      let recoveryPending = error instanceof HealingRecoveryPendingError
        || (error instanceof ExplorationEvidenceError && error.terminalCommitFailed);
      let safetyProofFailed = false;
      const message = redactSandboxText(
        error instanceof Error ? error.message : String(error) || "Unknown worker error",
      ).slice(0, 2_000);
      try {
        recordHealingWorkerError(dependencies.database, event.id, message);
      } catch {
        // Continue to later retailers even if this event's evidence store is unavailable.
      }
      let completed = null;
      if (!recoveryPending) {
        try {
          const resolution = finishHealingWorkerFailureIfSafe(dependencies.database, {
            healingEventId: event.id,
            errorMessage: message,
            finishedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          });
          recoveryPending = resolution.recoveryPending;
          completed = resolution.event;
        } catch {
          recoveryPending = true;
          safetyProofFailed = true;
        }
      }
      if (recoveryPending) {
        countOutcome("in_progress");
        try {
          await dependencies.alertSink?.send({
            severity: "error",
            title: "Healing worker recovery pending",
            message: "Recoverable exploration state could not be safely ruled out; the event and durable evidence remain open for stale-worker reconciliation",
            details: {
              healingEventId: event.id,
              retailerId: event.retailerId,
              error: message,
              safetyProofFailed,
            },
          });
        } catch {
          // Persisted evidence and later retailer processing take precedence.
        }
        continue;
      }
      countOutcome(
        completed?.status === "recovered"
          ? "recovered"
          : completed?.status === "provider_unavailable"
            ? "provider_unavailable"
            : completed?.status === "deferred"
              ? "deferred"
              : completed?.status === "superseded"
                ? "superseded"
                : "failed",
      );
      try {
        await dependencies.alertSink?.send({
          severity: "error",
          title: "Healing worker event failed",
          message: "One queued healing event failed in isolation; later retailers continued",
          details: { healingEventId: event.id, retailerId: event.retailerId, error: message },
        });
      } catch {
        // Persisted evidence and later retailer processing take precedence.
      }
    }
  }
  return summary;
}
