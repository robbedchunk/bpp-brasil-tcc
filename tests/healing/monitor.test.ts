import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/database.js";
import {
  beginExplorationRun,
  beginHealingEvent,
  reconcileHealingExploration,
  recordExplorationAttempt,
} from "../../src/db/repositories.js";
import type { AlertEvent } from "../../src/ops/alerts.js";
import {
  classificationMonthlyCommittedUsd,
  reserveExplorationBudget,
} from "../../src/ops/budget.js";
import {
  HealingRecoveryPendingError,
  healPendingEvents,
  healRetailer,
} from "../../src/healing/heal.js";
import { ExplorationEvidenceError } from "../../src/explorer/explore.js";
import { monitorRun } from "../../src/healing/monitor.js";
import { extractionStrategy, seedRetailer, seedStrategy } from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const temporaryDirectories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function seed(): ReturnType<typeof openDatabase> {
  const database = openDatabase(":memory:");
  databases.push(database);
  seedRetailer(database);
  seedStrategy(database, "extraction", extractionStrategy);
  return database;
}

function insertRun(
  database: ReturnType<typeof openDatabase>,
  id: string,
  failures: Array<{ category: string; responded: boolean }>,
  ok = 0,
  status = "failed",
  retailerId = "retailer-1",
): void {
  const strategyId = `${retailerId}-extraction-v1`;
  const attempted = ok + failures.length;
  database.prepare(
    `INSERT INTO runs
       (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
        status, attempted, ok, failed, started_at, finished_at, metadata_json)
     VALUES (?, ?, 'collect', '2026-07-10',
             ?, 1, ?, ?, ?, ?,
             '2026-07-10T00:00:00.000Z',
             CASE WHEN ? = 'running' THEN NULL ELSE '2026-07-10T00:01:00.000Z' END,
             ?)`,
  ).run(id, retailerId, strategyId, status, attempted, ok, failures.length, status, JSON.stringify({
    failureResponses: failures.map(({ responded }) => responded),
  }));
  const statement = database.prepare(
    `INSERT INTO run_failures
       (id, run_id, retailer_id, category, responded, message, strategy_id,
        strategy_version, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?,
             ?, 1, '2026-07-10T00:00:30.000Z')`,
  );
  failures.forEach((failure, index) => {
    statement.run(
      `${id}-failure-${index}`,
      id,
      retailerId,
      failure.category,
      failure.responded ? 1 : 0,
      `${id} fixture failure`,
      strategyId,
    );
  });
}

describe("drift monitor state machine", () => {
  it("alerts on blocking evidence without spending a generator call", async () => {
    const database = seed();
    insertRun(database, "blocked-run", [
      { category: "http-403", responded: true },
      { category: "http-403", responded: true },
    ]);
    let healingCalls = 0;
    const alerts: AlertEvent[] = [];

    const decision = await monitorRun("blocked-run", {
      database,
      heal: async () => {
        healingCalls += 1;
        throw new Error("must not heal blocking");
      },
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(decision).toMatchObject({ health: "blocking", action: "alerted" });
    expect(healingCalls).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS n FROM healing_events").get())
      .toEqual({ n: 0 });
  });

  it("only queues healing after a terminal drift run", async () => {
    const database = seed();
    insertRun(database, "drift-run", [
      { category: "missing-fields", responded: true },
      { category: "parse", responded: true },
    ]);
    let healingCalls = 0;

    const decision = await monitorRun("drift-run", {
      database,
      heal: async () => {
        healingCalls += 1;
        throw new Error("daily monitor must not generate");
      },
    });

    expect(healingCalls).toBe(0);
    expect(decision).toMatchObject({ health: "drift", action: "queued" });
    expect(database.prepare(
      "SELECT onset_run_id, previous_strategy_id, status FROM healing_events",
    ).get()).toEqual({
      onset_run_id: "drift-run",
      previous_strategy_id: "retailer-1-extraction-v1",
      status: "open",
    });
  });

  it("anchors a queued event to the onset run strategy, not a newer active strategy", async () => {
    const database = seed();
    insertRun(database, "onset-v1", [{ category: "missing-fields", responded: true }]);
    database.prepare(
      "UPDATE strategies SET active = 0, retired_at = '2026-07-10T00:02:00.000Z' WHERE id = ?",
    ).run("retailer-1-extraction-v1");
    database.prepare(
      `INSERT INTO strategies
         (id, retailer_id, purpose, tier, version, strategy_json, provenance,
          validation_sample_size, validation_successes, validation_rate,
          active, validated_at, activated_at)
       VALUES ('retailer-1-extraction-v2', 'retailer-1', 'extraction', 4, 2, ?,
               'fixture successor', 30, 30, 1, 1,
               '2026-07-10T00:02:00.000Z', '2026-07-10T00:02:00.000Z')`,
    ).run(JSON.stringify({ ...extractionStrategy, tier: "script", script: "return {};" }));

    await monitorRun("onset-v1", { database });

    expect(database.prepare(
      "SELECT previous_strategy_id, tier_from FROM healing_events",
    ).get()).toEqual({
      previous_strategy_id: "retailer-1-extraction-v1",
      tier_from: 1,
    });
  });

  it("defers a non-terminal run and never calls healing", async () => {
    const database = seed();
    insertRun(database, "running-run", [], 0, "running");
    let healingCalls = 0;

    const decision = await monitorRun("running-run", {
      database,
      heal: async () => {
        healingCalls += 1;
        throw new Error("must not heal running work");
      },
    });

    expect(decision).toMatchObject({ action: "not_terminal" });
    expect(healingCalls).toBe(0);
  });

  it("degrades only this retailer after three failed regeneration events, not inner attempts", async () => {
    const database = seed();
    for (let index = 1; index <= 3; index += 1) {
      insertRun(database, `drift-${index}`, [
        { category: "missing-fields", responded: true },
      ]);
    }
    const alerts: AlertEvent[] = [];
    const explore = async () => ({
      explorationRunId: "exploration-fixture",
      activated: false,
      attempts: 3,
      externalScore: 0.8,
      outcome: "validation_failed" as const,
      costUsd: 0.1,
    });

    const first = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "drift-1",
      explore,
      alertSink: { send: async (event) => { alerts.push(event); } },
    });
    expect(first).toMatchObject({ attempts: 3, degraded: false });
    await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "drift-2",
      explore,
      alertSink: { send: async (event) => { alerts.push(event); } },
    });
    const third = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "drift-3",
      explore,
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(third).toMatchObject({ status: "failed", degraded: true });
    expect(database.prepare(
      "SELECT degraded, degraded_reason FROM retailers WHERE id = 'retailer-1'",
    ).get()).toMatchObject({ degraded: 1 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM healing_events").get())
      .toEqual({ n: 3 });
    expect(alerts.at(-1)).toMatchObject({ severity: "error" });

    insertRun(database, "drift-4", [
      { category: "missing-fields", responded: true },
    ]);
    const fourth = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "drift-4",
      explore,
      alertSink: { send: async (event) => { alerts.push(event); } },
    });
    expect(fourth).toMatchObject({ status: "failed", degraded: true });
    expect(alerts.filter(({ title }) => title === "Retailer strategy healing degraded"))
      .toHaveLength(1);
  });

  it("records a provider-unavailable healing event and never retires the strategy", async () => {
    const database = seed();
    insertRun(database, "no-key-drift", [
      { category: "missing-fields", responded: true },
    ]);
    const alerts: AlertEvent[] = [];

    const outcome = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "no-key-drift",
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(outcome).toMatchObject({
      status: "provider_unavailable",
      activated: false,
      degraded: false,
    });
    expect(database.prepare(
      "SELECT id FROM strategies WHERE retailer_id = 'retailer-1' AND active = 1",
    ).all()).toEqual([{ id: "retailer-1-extraction-v1" }]);
    expect(alerts).toHaveLength(1);
  });

  it("refuses direct healing for a blocking onset without opening an event or calling exploration", async () => {
    const database = seed();
    insertRun(database, "blocking-onset", [
      { category: "http-403", responded: true },
      { category: "http-403", responded: true },
    ]);
    let explorationCalls = 0;

    await expect(healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "blocking-onset",
      explore: async () => {
        explorationCalls += 1;
        return {
          explorationRunId: "must-not-exist",
          activated: false,
          attempts: 1,
          externalScore: 0,
          outcome: "validation_failed",
          costUsd: 0,
        };
      },
    })).rejects.toThrow(/drift/iu);
    expect(explorationCalls).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS n FROM healing_events").get())
      .toEqual({ n: 0 });
  });

  it("does not count budget-deferred work as failed regeneration events", async () => {
    const database = seed();
    for (let index = 1; index <= 3; index += 1) {
      insertRun(database, `budget-drift-${index}`, [
        { category: "missing-fields", responded: true },
      ]);
      await healRetailer("retailer-1", "extraction", {
        database,
        onsetRunId: `budget-drift-${index}`,
        explore: async () => ({
          explorationRunId: `budget-exploration-${index}`,
          activated: false,
          attempts: 1,
          externalScore: null,
          outcome: "budget_paused",
          costUsd: 0,
        }),
      });
    }

    expect(database.prepare(
      "SELECT status FROM healing_events ORDER BY rowid",
    ).all()).toEqual([
      { status: "deferred" },
      { status: "deferred" },
      { status: "deferred" },
    ]);
    expect(database.prepare(
      "SELECT degraded FROM retailers WHERE id = 'retailer-1'",
    ).get()).toEqual({ degraded: 0 });
  });

  it("does not duplicate a specific budget-overrun alert with a pending alert", async () => {
    const database = seed();
    insertRun(database, "alerted-overrun", [
      { category: "missing-fields", responded: true },
    ]);
    const alerts: AlertEvent[] = [];

    const outcome = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "alerted-overrun",
      explore: async () => ({
        explorationRunId: "alerted-exploration",
        activated: false,
        attempts: 1,
        externalScore: null,
        outcome: "budget_exhausted",
        costUsd: 5.1,
        alerted: true,
      }),
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(outcome.status).toBe("deferred");
    expect(alerts).toHaveLength(0);
  });

  it("reclaims a stale open event after a crashed healing worker", async () => {
    const database = seed();
    insertRun(database, "stale-drift", [
      { category: "missing-fields", responded: true },
    ]);
    const opened = beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "stale-drift",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(opened.created).toBe(true);
    let explorationCalls = 0;

    const outcome = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "stale-drift",
      now: () => new Date("2026-07-10T00:16:00.000Z"),
      explore: async () => {
        explorationCalls += 1;
        return {
          explorationRunId: "stale-retry",
          activated: false,
          attempts: 1,
          externalScore: 0.8,
          outcome: "validation_failed",
          costUsd: 0,
        };
      },
    });

    expect(explorationCalls).toBe(1);
    expect(outcome).toMatchObject({
      healingEventId: opened.event.id,
      status: "failed",
    });
  });

  it("never reclaims onset A while asked to heal onset B", async () => {
    const database = seed();
    insertRun(database, "drift-a", [{ category: "missing-fields", responded: true }]);
    insertRun(database, "drift-b", [{ category: "missing-fields", responded: true }]);
    const opened = beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "drift-a",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    let explorationCalls = 0;

    const outcome = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "drift-b",
      now: () => new Date("2026-07-10T00:30:00.000Z"),
      explore: async () => {
        explorationCalls += 1;
        throw new Error("onset B must wait for A");
      },
    });

    expect(outcome).toMatchObject({ status: "in_progress" });
    expect(explorationCalls).toBe(0);
    expect(database.prepare("SELECT onset_run_id, status FROM healing_events").all())
      .toEqual([
        { onset_run_id: "drift-a", status: "open" },
        { onset_run_id: "drift-b", status: "queued" },
      ]);
    expect(outcome.healingEventId).not.toBe(opened.event.id);
  });

  it("durably queues onset B behind A and processes both with their own evidence", async () => {
    const database = seed();
    insertRun(database, "queued-a", [{ category: "missing-fields", responded: true }]);
    insertRun(database, "queued-b", [{ category: "parse", responded: true }]);
    beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "queued-a",
      detectedAt: "2026-07-10T00:00:00.000Z",
      queued: true,
    });

    const decision = await monitorRun("queued-b", {
      database,
      now: () => new Date("2026-07-10T00:01:00.000Z"),
    });
    expect(decision).toMatchObject({ action: "queued", healingEventId: expect.any(String) });
    expect(database.prepare(
      "SELECT onset_run_id, status FROM healing_events ORDER BY detected_at",
    ).all()).toEqual([
      { onset_run_id: "queued-a", status: "open" },
      { onset_run_id: "queued-b", status: "queued" },
    ]);

    const evidence: string[] = [];
    const summary = await healPendingEvents({
      database,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      explore: async (_retailerId, _purpose, dependencies) => {
        evidence.push(dependencies.failureSamples?.[0]?.message ?? "missing");
        return {
          explorationRunId: `failure-${evidence.length}`,
          activated: false,
          attempts: 1,
          externalScore: 0.8,
          outcome: "validation_failed",
          costUsd: 0.1,
        };
      },
    });

    expect(summary).toMatchObject({ processed: 2, failed: 2 });
    expect(evidence).toEqual([
      "queued-a fixture failure",
      "queued-b fixture failure",
    ]);
    expect(database.prepare(
      "SELECT onset_run_id, status FROM healing_events ORDER BY detected_at",
    ).all()).toEqual([
      { onset_run_id: "queued-a", status: "failed" },
      { onset_run_id: "queued-b", status: "failed" },
    ]);
  });

  it("uses authoritative exploration evidence when an outer call throws", async () => {
    const database = seed();
    insertRun(database, "paid-throw", [{ category: "missing-fields", responded: true }]);
    const authoritative = {
      explorationRunId: "paid-exploration",
      activated: false,
      attempts: 2,
      externalScore: 0.4,
      outcome: "provider_failed" as const,
      costUsd: 0.75,
    };

    const result = await healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "paid-throw",
      explore: async () => {
        throw new ExplorationEvidenceError("fixture outer failure", authoritative);
      },
    });

    expect(result).toMatchObject({ attempts: 2, status: "failed", explorationRunId: "paid-exploration" });
    const event = database.prepare(
      "SELECT attempts, status, details_json FROM healing_events",
    ).get() as { attempts: number; status: string; details_json: string };
    expect(event).toMatchObject({ attempts: 2, status: "failed" });
    expect(JSON.parse(event.details_json)).toMatchObject({
      explorationRunId: "paid-exploration",
      costUsd: 0.75,
    });
  });

  it("never closes a healing event separately after its atomic terminal commit fails", async () => {
    const database = seed();
    insertRun(database, "atomic-terminal-throw", [
      { category: "missing-fields", responded: true },
    ]);
    const authoritative = {
      explorationRunId: "atomic-terminal-exploration",
      activated: false,
      attempts: 1,
      externalScore: 0.5,
      outcome: "validation_failed" as const,
      costUsd: 0.01,
    };

    await expect(healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "atomic-terminal-throw",
      explore: async () => {
        throw new ExplorationEvidenceError(
          "atomic terminal transaction failed",
          authoritative,
          { terminalCommitFailed: true },
        );
      },
    })).rejects.toMatchObject({
      name: "ExplorationEvidenceError",
      outcome: authoritative,
    });
    expect(database.prepare("SELECT status FROM healing_events").get())
      .toEqual({ status: "open" });
  });

  it("preserves terminal-commit failures for recovery while processing later retailers", async () => {
    const database = seed();
    seedRetailer(database, "retailer-2");
    seedStrategy(database, "extraction", extractionStrategy, "retailer-2");
    insertRun(database, "terminal-worker-1", [
      { category: "missing-fields", responded: true },
    ]);
    insertRun(database, "terminal-worker-2", [
      { category: "missing-fields", responded: true },
    ], 0, "failed", "retailer-2");
    for (const [index, [retailerId, onsetRunId]] of [
      ["retailer-1", "terminal-worker-1"],
      ["retailer-2", "terminal-worker-2"],
    ].entries()) {
      beginHealingEvent(database, {
        retailerId,
        purpose: "extraction",
        onsetRunId,
        detectedAt: `2026-07-10T00:0${index}:00.000Z`,
        queued: true,
      });
    }
    const explored: string[] = [];

    const summary = await healPendingEvents({
      database,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      explore: async (retailerId) => {
        explored.push(retailerId);
        if (retailerId === "retailer-1") {
          throw new ExplorationEvidenceError(
            "fixture terminal transaction failed",
            {
              explorationRunId: "terminal-evidence",
              activated: false,
              attempts: 1,
              externalScore: 0.5,
              outcome: "validation_failed",
              costUsd: 0.01,
            },
            { terminalCommitFailed: true },
          );
        }
        return {
          explorationRunId: "later-provider",
          activated: false,
          attempts: 1,
          externalScore: null,
          outcome: "provider_unavailable",
          costUsd: 0,
        };
      },
    });

    expect(explored).toEqual(["retailer-1", "retailer-2"]);
    expect(summary).toMatchObject({
      queued: 2,
      processed: 1,
      failed: 0,
      providerUnavailable: 1,
      inProgress: 1,
      workerErrors: 1,
    });
    expect(database.prepare(
      "SELECT retailer_id, status, attempts FROM healing_events ORDER BY retailer_id",
    ).all()).toEqual([
      { retailer_id: "retailer-1", status: "open", attempts: 0 },
      { retailer_id: "retailer-2", status: "provider_unavailable", attempts: 1 },
    ]);
  });

  it("charges the unaccounted reservation remainder when a paid exploration crashes", async () => {
    const database = seed();
    insertRun(database, "paid-crash", [{ category: "missing-fields", responded: true }]);
    const healing = beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "paid-crash",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    const explorationRunId = beginExplorationRun(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      trigger: "healing",
      previousStrategyId: "retailer-1-extraction-v1",
      healingEventId: healing.event.id,
      maxAttempts: 3,
      startedAt: "2026-07-10T00:01:00.000Z",
    });
    reserveExplorationBudget(database, {
      explorationRunId,
      retailerId: "retailer-1",
      eventAllowanceUsd: 5,
      monthlyLimitUsd: 50,
      now: new Date("2026-07-10T00:01:00.000Z"),
    });
    recordExplorationAttempt(database, {
      explorationRunId,
      attemptNumber: 1,
      model: "fixture-model",
      promptVersion: "fixture-prompt",
      promptHash: "a".repeat(64),
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      costUsd: 0.75,
      costEstimated: true,
      estimateSource: "fixture-rate",
      rateVersion: "fixture-v1",
      externalSampleSize: 30,
      externalSuccesses: 24,
      externalScore: 0.8,
      outcome: "validation_failed",
      errorMessage: "candidate missed trusted gate",
      createdAt: "2026-07-10T00:02:00.000Z",
    });
    let modelCalls = 0;

    const summary = await healPendingEvents({
      database,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      explore: async () => {
        modelCalls += 1;
        throw new Error("crash recovery must not regenerate");
      },
    });

    expect(modelCalls).toBe(0);
    expect(summary).toMatchObject({ processed: 1, failed: 1, workerErrors: 0 });
    expect(database.prepare(
      "SELECT status, outcome, events_used, cost_usd FROM exploration_runs WHERE id = ?",
    ).get(explorationRunId)).toEqual({
      status: "finished",
      outcome: "validation_failed",
      events_used: 1,
      cost_usd: 5,
    });
    const adjustment = database.prepare(
      `SELECT a.amount_usd, a.reserved_amount_usd, a.cost_ledger_id,
              l.category, l.provider, l.input_tokens, l.output_tokens,
              l.cost_usd
       FROM exploration_recovery_adjustments AS a
       JOIN cost_ledger AS l ON l.id = a.cost_ledger_id
       WHERE a.exploration_run_id = ?`,
    ).get(explorationRunId);
    expect(adjustment).toMatchObject({
      amount_usd: 4.25,
      reserved_amount_usd: 5,
      category: "strategy-exploration-recovery",
      provider: "internal-recovery",
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 4.25,
    });
    expect(database.prepare(
      "SELECT SUM(cost_usd) AS cost_usd FROM cost_ledger WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ cost_usd: 5 });
    expect(database.prepare(
      "SELECT status, actual_cost_usd FROM model_budget_reservations WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ status: "settled", actual_cost_usd: 5 });
    const event = database.prepare(
      "SELECT status, attempts, details_json FROM healing_events WHERE id = ?",
    ).get(healing.event.id) as { status: string; attempts: number; details_json: string };
    expect(event).toMatchObject({ status: "failed", attempts: 1 });
    expect(JSON.parse(event.details_json)).toMatchObject({
      reconciled: true,
      explorationRunId,
      explorationOutcome: "validation_failed",
      attemptCostUsd: 0.75,
      recoveryAdjustmentUsd: 4.25,
      costUsd: 5,
    });
    expect(classificationMonthlyCommittedUsd(
      database,
      new Date("2026-07-10T00:20:00.000Z"),
    )).toBe(5);

    const retried = reconcileHealingExploration(database, {
      healingEventId: healing.event.id,
      finishedAt: "2026-07-10T00:21:00.000Z",
    });
    expect(retried).toMatchObject({
      explorationRunId,
      attempts: 1,
      costUsd: 5,
      status: "failed",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM exploration_recovery_adjustments WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 1 });
  });

  it("charges the full active reservation for a crashed zero-attempt exploration", async () => {
    const database = seed();
    insertRun(database, "zero-crash", [{ category: "missing-fields", responded: true }]);
    const healing = beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "zero-crash",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    const explorationRunId = beginExplorationRun(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      trigger: "healing",
      previousStrategyId: "retailer-1-extraction-v1",
      healingEventId: healing.event.id,
      maxAttempts: 3,
      startedAt: "2026-07-10T00:01:00.000Z",
    });
    reserveExplorationBudget(database, {
      explorationRunId,
      retailerId: "retailer-1",
      eventAllowanceUsd: 5,
      monthlyLimitUsd: 50,
      now: new Date("2026-07-10T00:01:00.000Z"),
    });
    let modelCalls = 0;

    const summary = await healPendingEvents({
      database,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      explore: async () => {
        modelCalls += 1;
        throw new Error("zero-attempt crash recovery must not regenerate");
      },
    });

    expect(modelCalls).toBe(0);
    expect(summary).toMatchObject({ processed: 1, deferred: 1, workerErrors: 0 });
    expect(database.prepare(
      "SELECT status, outcome, events_used, cost_usd FROM exploration_runs WHERE id = ?",
    ).get(explorationRunId)).toEqual({
      status: "finished",
      outcome: "recovery_zero_attempt",
      events_used: 0,
      cost_usd: 5,
    });
    expect(database.prepare(
      "SELECT status, actual_cost_usd FROM model_budget_reservations WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ status: "settled", actual_cost_usd: 5 });
    expect(database.prepare(
      `SELECT a.amount_usd, l.cost_usd
       FROM exploration_recovery_adjustments AS a
       JOIN cost_ledger AS l ON l.id = a.cost_ledger_id
       WHERE a.exploration_run_id = ?`,
    ).get(explorationRunId)).toEqual({ amount_usd: 5, cost_usd: 5 });
    const event = database.prepare(
      "SELECT status, attempts, details_json FROM healing_events WHERE id = ?",
    ).get(healing.event.id) as { status: string; attempts: number; details_json: string };
    expect(event).toMatchObject({ status: "deferred", attempts: 0 });
    expect(JSON.parse(event.details_json)).toMatchObject({
      attemptCostUsd: 0,
      recoveryAdjustmentUsd: 5,
      costUsd: 5,
    });
  });

  it("reconciles a zero-attempt pre-reservation crash once across concurrent workers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "healing-reconcile-race-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "precos.sqlite");
    const firstDatabase = openDatabase(databasePath);
    databases.push(firstDatabase);
    seedRetailer(firstDatabase);
    seedStrategy(firstDatabase, "extraction", extractionStrategy);
    insertRun(firstDatabase, "concurrent-crash", [
      { category: "missing-fields", responded: true },
    ]);
    const healing = beginHealingEvent(firstDatabase, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "concurrent-crash",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    const explorationRunId = beginExplorationRun(firstDatabase, {
      retailerId: "retailer-1",
      purpose: "extraction",
      trigger: "healing",
      previousStrategyId: "retailer-1-extraction-v1",
      healingEventId: healing.event.id,
      maxAttempts: 3,
      startedAt: "2026-07-10T00:01:00.000Z",
    });
    const secondDatabase = openDatabase(databasePath);
    databases.push(secondDatabase);
    let modelCalls = 0;
    const worker = (database: ReturnType<typeof openDatabase>) => healPendingEvents({
      database,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      explore: async () => {
        modelCalls += 1;
        throw new Error("concurrent recovery must not regenerate");
      },
    });

    const summaries = await Promise.all([
      worker(firstDatabase),
      worker(secondDatabase),
    ]);

    expect(modelCalls).toBe(0);
    expect(summaries.reduce((sum, summary) => sum + summary.processed, 0)).toBe(1);
    expect(summaries.reduce((sum, summary) => sum + summary.deferred, 0)).toBe(1);
    expect(firstDatabase.prepare(
      "SELECT status, attempts FROM healing_events WHERE id = ?",
    ).get(healing.event.id)).toEqual({ status: "deferred", attempts: 0 });
    expect(firstDatabase.prepare(
      "SELECT status, outcome FROM exploration_runs WHERE id = ?",
    ).get(explorationRunId)).toEqual({
      status: "finished",
      outcome: "recovery_zero_attempt",
    });
    expect(firstDatabase.prepare(
      "SELECT COUNT(*) AS count FROM model_budget_reservations WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 0 });
    expect(firstDatabase.prepare(
      "SELECT COUNT(*) AS count FROM exploration_runs WHERE healing_event_id = ?",
    ).get(healing.event.id)).toEqual({ count: 1 });
    expect(firstDatabase.prepare(
      "SELECT COUNT(*) AS count FROM exploration_recovery_adjustments WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 0 });
    expect(firstDatabase.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd FROM cost_ledger WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ cost_usd: 0 });
  });

  it("reconciles a provably free pre-reservation attempt without inventing spend", () => {
    const database = seed();
    insertRun(database, "free-attempt-crash", [
      { category: "missing-fields", responded: true },
    ]);
    const healing = beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "free-attempt-crash",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    const explorationRunId = beginExplorationRun(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      trigger: "healing",
      previousStrategyId: "retailer-1-extraction-v1",
      healingEventId: healing.event.id,
      maxAttempts: 3,
      startedAt: "2026-07-10T00:01:00.000Z",
    });
    recordExplorationAttempt(database, {
      explorationRunId,
      attemptNumber: 1,
      model: "fixture-model",
      promptVersion: "fixture-prompt",
      promptHash: "c".repeat(64),
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      costUsd: 0,
      costEstimated: false,
      estimateSource: "provider-unavailable-before-call",
      rateVersion: "fixture-v1",
      outcome: "provider_unavailable",
      errorMessage: "credentials unavailable before invocation",
      createdAt: "2026-07-10T00:02:00.000Z",
    });

    const result = reconcileHealingExploration(database, {
      healingEventId: healing.event.id,
      finishedAt: "2026-07-10T00:20:00.000Z",
    });

    expect(result).toMatchObject({
      explorationRunId,
      outcome: "provider_unavailable",
      status: "provider_unavailable",
      attempts: 1,
      costUsd: 0,
    });
    expect(database.prepare(
      "SELECT status, events_used, input_tokens, output_tokens, cost_usd FROM exploration_runs WHERE id = ?",
    ).get(explorationRunId)).toEqual({
      status: "finished",
      events_used: 1,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM model_budget_reservations WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM exploration_recovery_adjustments WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 0 });
  });

  it("rolls back the recovery adjustment bundle and retries it idempotently", () => {
    const database = seed();
    insertRun(database, "rollback-crash", [
      { category: "missing-fields", responded: true },
    ]);
    const healing = beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "rollback-crash",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    const explorationRunId = beginExplorationRun(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      trigger: "healing",
      previousStrategyId: "retailer-1-extraction-v1",
      healingEventId: healing.event.id,
      maxAttempts: 3,
      startedAt: "2026-07-10T00:01:00.000Z",
    });
    reserveExplorationBudget(database, {
      explorationRunId,
      retailerId: "retailer-1",
      eventAllowanceUsd: 5,
      monthlyLimitUsd: 50,
      now: new Date("2026-07-10T00:01:00.000Z"),
    });
    database.exec(`
      CREATE TEMP TRIGGER fixture_block_reservation_settlement
      BEFORE UPDATE ON model_budget_reservations
      BEGIN
        SELECT RAISE(ABORT, 'fixture settlement failure');
      END;
    `);

    expect(() => reconcileHealingExploration(database, {
      healingEventId: healing.event.id,
      finishedAt: "2026-07-10T00:20:00.000Z",
    })).toThrow(/fixture settlement failure/iu);
    expect(database.prepare(
      "SELECT status, cost_usd FROM exploration_runs WHERE id = ?",
    ).get(explorationRunId)).toEqual({ status: "running", cost_usd: 0 });
    expect(database.prepare(
      "SELECT status, actual_cost_usd FROM model_budget_reservations WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ status: "reserved", actual_cost_usd: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM exploration_recovery_adjustments WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM cost_ledger WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status FROM healing_events WHERE id = ?",
    ).get(healing.event.id)).toEqual({ status: "open" });

    database.exec("DROP TRIGGER fixture_block_reservation_settlement");
    const result = reconcileHealingExploration(database, {
      healingEventId: healing.event.id,
      finishedAt: "2026-07-10T00:21:00.000Z",
    });
    expect(result).toMatchObject({ costUsd: 5, attempts: 0, status: "deferred" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM exploration_recovery_adjustments WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 1 });
  });

  it("keeps reconciliation mismatches recovery-pending, continues later retailers, and retries", async () => {
    const database = seed();
    seedRetailer(database, "retailer-2");
    seedStrategy(database, "extraction", extractionStrategy, "retailer-2");
    insertRun(database, "mismatch-recovery", [
      { category: "missing-fields", responded: true },
    ]);
    insertRun(database, "later-recovery", [
      { category: "missing-fields", responded: true },
    ], 0, "failed", "retailer-2");
    const mismatchHealing = beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "mismatch-recovery",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    beginHealingEvent(database, {
      retailerId: "retailer-2",
      purpose: "extraction",
      onsetRunId: "later-recovery",
      detectedAt: "2026-07-10T00:01:00.000Z",
    });
    const explorationRunId = beginExplorationRun(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      trigger: "healing",
      previousStrategyId: "retailer-1-extraction-v1",
      healingEventId: mismatchHealing.event.id,
      maxAttempts: 3,
      startedAt: "2026-07-10T00:02:00.000Z",
    });
    reserveExplorationBudget(database, {
      explorationRunId,
      retailerId: "retailer-1",
      eventAllowanceUsd: 5,
      monthlyLimitUsd: 50,
      now: new Date("2026-07-10T00:02:00.000Z"),
    });
    recordExplorationAttempt(database, {
      explorationRunId,
      attemptNumber: 1,
      model: "fixture-model",
      promptVersion: "fixture-prompt",
      promptHash: "b".repeat(64),
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      costUsd: 1,
      costEstimated: true,
      estimateSource: "fixture-rate",
      rateVersion: "fixture-v1",
      externalSampleSize: 30,
      externalSuccesses: 24,
      externalScore: 0.8,
      outcome: "validation_failed",
      createdAt: "2026-07-10T00:03:00.000Z",
    });
    database.prepare(
      "UPDATE exploration_runs SET cost_usd = 0.5 WHERE id = ?",
    ).run(explorationRunId);

    await expect(healRetailer("retailer-1", "extraction", {
      database,
      onsetRunId: "mismatch-recovery",
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      explore: async () => {
        throw new Error("evidence mismatch must not regenerate");
      },
    })).rejects.toBeInstanceOf(HealingRecoveryPendingError);

    const explored: string[] = [];
    const alerts: AlertEvent[] = [];
    const summary = await healPendingEvents({
      database,
      now: () => new Date("2026-07-10T00:40:00.000Z"),
      explore: async (retailerId) => {
        explored.push(retailerId);
        if (retailerId === "retailer-1") {
          throw new Error("reconciliation mismatch must not regenerate");
        }
        return {
          explorationRunId: "later-provider-unavailable",
          activated: false,
          attempts: 0,
          externalScore: null,
          outcome: "provider_unavailable",
          costUsd: 0,
        };
      },
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(explored).toEqual(["retailer-2"]);
    expect(summary).toMatchObject({
      queued: 2,
      processed: 1,
      providerUnavailable: 1,
      inProgress: 1,
      workerErrors: 1,
      failed: 0,
    });
    expect(alerts.some(({ title }) => title === "Healing worker recovery pending")).toBe(true);
    expect(database.prepare(
      "SELECT status, cost_usd FROM exploration_runs WHERE id = ?",
    ).get(explorationRunId)).toEqual({ status: "running", cost_usd: 0.5 });
    expect(database.prepare(
      "SELECT status FROM model_budget_reservations WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ status: "reserved" });
    expect(database.prepare(
      "SELECT status FROM healing_events WHERE id = ?",
    ).get(mismatchHealing.event.id)).toEqual({ status: "open" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM exploration_recovery_adjustments WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ count: 0 });

    database.prepare(
      "UPDATE exploration_runs SET cost_usd = 1 WHERE id = ?",
    ).run(explorationRunId);
    const retry = await healPendingEvents({
      database,
      retailerId: "retailer-1",
      now: () => new Date("2026-07-10T01:00:00.000Z"),
      explore: async () => {
        throw new Error("corrected recovery must not regenerate");
      },
    });

    expect(retry).toMatchObject({
      queued: 1,
      processed: 1,
      failed: 1,
      inProgress: 0,
      workerErrors: 0,
    });
    expect(database.prepare(
      "SELECT status, cost_usd FROM exploration_runs WHERE id = ?",
    ).get(explorationRunId)).toEqual({ status: "finished", cost_usd: 5 });
    expect(database.prepare(
      "SELECT status, actual_cost_usd FROM model_budget_reservations WHERE exploration_run_id = ?",
    ).get(explorationRunId)).toEqual({ status: "settled", actual_cost_usd: 5 });
    const event = database.prepare(
      "SELECT status, details_json FROM healing_events WHERE id = ?",
    ).get(mismatchHealing.event.id) as { status: string; details_json: string };
    expect(event.status).toBe("failed");
    expect(JSON.parse(event.details_json)).toMatchObject({
      attemptCostUsd: 1,
      recoveryAdjustmentUsd: 4,
      costUsd: 5,
    });
  });

  it("isolates each pending retailer and persists a sanitized worker error", async () => {
    const database = seed();
    seedRetailer(database, "retailer-2");
    seedStrategy(database, "extraction", extractionStrategy, "retailer-2");
    insertRun(database, "isolation-1", [
      { category: "missing-fields", responded: true },
    ]);
    insertRun(database, "isolation-2", [
      { category: "missing-fields", responded: true },
    ], 0, "failed", "retailer-2");
    for (const [index, [retailerId, onsetRunId]] of [
      ["retailer-1", "isolation-1"],
      ["retailer-2", "isolation-2"],
    ].entries()) {
      beginHealingEvent(database, {
        retailerId,
        purpose: "extraction",
        onsetRunId,
        detectedAt: `2026-07-10T00:0${index}:00.000Z`,
        queued: true,
      });
    }
    let firstAlert = true;
    const alerts: AlertEvent[] = [];

    const summary = await healPendingEvents({
      database,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      explore: async (retailerId) => ({
        explorationRunId: `provider-${retailerId}`,
        activated: false,
        attempts: 1,
        externalScore: null,
        outcome: "provider_unavailable",
        costUsd: 0,
      }),
      alertSink: {
        send: async (event) => {
          if (firstAlert) {
            firstAlert = false;
            throw new Error("Bearer should-not-persist");
          }
          alerts.push(event);
        },
      },
    });

    expect(summary).toMatchObject({
      processed: 2,
      providerUnavailable: 2,
      workerErrors: 1,
    });
    expect(database.prepare(
      "SELECT retailer_id, status FROM healing_events ORDER BY retailer_id",
    ).all()).toEqual([
      { retailer_id: "retailer-1", status: "provider_unavailable" },
      { retailer_id: "retailer-2", status: "provider_unavailable" },
    ]);
    const firstDetails = database.prepare(
      "SELECT details_json FROM healing_events WHERE retailer_id = 'retailer-1'",
    ).get() as { details_json: string };
    expect(JSON.parse(firstDetails.details_json)).toMatchObject({
      workerError: expect.stringContaining("[REDACTED]"),
    });
    expect(firstDetails.details_json).not.toContain("should-not-persist");
    expect(alerts.some(({ title }) => title === "Healing worker event failed")).toBe(true);
  });

  it("supersedes queued healing when the onset strategy is no longer active", async () => {
    const database = seed();
    insertRun(database, "old-drift", [{ category: "missing-fields", responded: true }]);
    const opened = beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "old-drift",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });
    database.prepare(
      "UPDATE strategies SET active = 0, retired_at = '2026-07-10T00:05:00.000Z' WHERE id = ?",
    ).run("retailer-1-extraction-v1");
    database.prepare(
      `INSERT INTO strategies
         (id, retailer_id, purpose, tier, version, strategy_json, provenance,
          validation_sample_size, validation_successes, validation_rate,
          active, validated_at, activated_at)
       VALUES ('retailer-1-extraction-v2', 'retailer-1', 'extraction', 3, 2, ?,
               'fixture successor', 30, 30, 1, 1,
               '2026-07-10T00:05:00.000Z', '2026-07-10T00:05:00.000Z')`,
    ).run(JSON.stringify(extractionStrategy));
    let explorationCalls = 0;

    const summary = await healPendingEvents({
      database,
      now: () => new Date("2026-07-10T00:30:00.000Z"),
      explore: async () => {
        explorationCalls += 1;
        throw new Error("superseded work must not spend");
      },
    });

    expect(explorationCalls).toBe(0);
    expect(summary).toMatchObject({ processed: 1, superseded: 1 });
    expect(database.prepare("SELECT status FROM healing_events WHERE id = ?").get(opened.event.id))
      .toEqual({ status: "superseded" });
    expect(database.prepare(
      "SELECT id FROM strategies WHERE retailer_id = 'retailer-1' AND active = 1",
    ).get()).toEqual({ id: "retailer-1-extraction-v2" });
  });
});
