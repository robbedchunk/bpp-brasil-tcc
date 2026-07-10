import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { beginHealingEvent } from "../../src/db/repositories.js";
import type { AlertEvent } from "../../src/ops/alerts.js";
import { healRetailer } from "../../src/healing/heal.js";
import { monitorRun } from "../../src/healing/monitor.js";
import { extractionStrategy, seedRetailer, seedStrategy } from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

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
): void {
  const attempted = ok + failures.length;
  database.prepare(
    `INSERT INTO runs
       (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
        status, attempted, ok, failed, started_at, finished_at, metadata_json)
     VALUES (?, 'retailer-1', 'collect', '2026-07-10',
             'retailer-1-extraction-v1', 1, ?, ?, ?, ?,
             '2026-07-10T00:00:00.000Z',
             CASE WHEN ? = 'running' THEN NULL ELSE '2026-07-10T00:01:00.000Z' END,
             ?)`,
  ).run(id, status, attempted, ok, failures.length, status, JSON.stringify({
    failureResponses: failures.map(({ responded }) => responded),
  }));
  const statement = database.prepare(
    `INSERT INTO run_failures
       (id, run_id, retailer_id, category, message, strategy_id,
        strategy_version, occurred_at)
     VALUES (?, ?, 'retailer-1', ?, 'fixture failure',
             'retailer-1-extraction-v1', 1, '2026-07-10T00:00:30.000Z')`,
  );
  failures.forEach((failure, index) => {
    statement.run(`${id}-failure-${index}`, id, failure.category);
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

  it("invokes healing only after a terminal drift run", async () => {
    const database = seed();
    insertRun(database, "drift-run", [
      { category: "missing-fields", responded: true },
      { category: "parse", responded: true },
    ]);
    let onsetRunId = "";

    const decision = await monitorRun("drift-run", {
      database,
      heal: async (_retailerId, _purpose, dependencies) => {
        onsetRunId = dependencies.onsetRunId;
        return {
          healingEventId: "healing-1",
          status: "recovered",
          attempts: 1,
          activated: true,
          degraded: false,
        };
      },
    });

    expect(onsetRunId).toBe("drift-run");
    expect(decision).toMatchObject({ health: "drift", action: "healed" });
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
});
