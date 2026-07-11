import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { NoActiveRetailersError, runDaily } from "../../src/pipeline/daily.js";
import { seedRetailer } from "./helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("daily pipeline", () => {
  it("records a successful heartbeat only after every active retailer terminates", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database, "a");
    seedRetailer(database, "b");
    const order: string[] = [];

    const summary = await runDaily({
      database,
      now: () => new Date("2026-07-10T06:00:00.000Z"),
      collect: async (retailerId) => {
        order.push(retailerId);
        return {
          id: `run-${retailerId}`,
          retailerId,
          stage: "collect",
          attempted: 1,
          ok: 1,
          failed: 0,
          successRate: 1,
          status: "completed",
          startedAt: "2026-07-10T06:00:00.000Z",
          finishedAt: "2026-07-10T06:00:00.000Z",
          dryRun: false,
        };
      },
    });

    expect(order).toEqual(["a", "b"]);
    expect(summary).toMatchObject({ retailers: 2, terminal: 2, heartbeatRecorded: true });
    expect(database.prepare("SELECT pipeline, status FROM heartbeats").get()).toEqual({
      pipeline: "collect",
      status: "completed",
    });
    const heartbeat = database.prepare("SELECT details_json FROM heartbeats").get() as {
      details_json: string;
    };
    expect(JSON.parse(heartbeat.details_json)).toMatchObject({ trigger: "manual" });
  });

  it("records explicit installed-timer provenance without relying on wall-clock time", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database, "a");

    await runDaily({
      database,
      trigger: "systemd-timer",
      now: () => new Date("2026-07-10T09:47:00.000Z"),
      collect: async () => ({
        id: "run-a",
        retailerId: "a",
        stage: "collect",
        attempted: 1,
        ok: 1,
        failed: 0,
        successRate: 1,
        status: "completed",
        startedAt: "2026-07-10T09:47:00.000Z",
        finishedAt: "2026-07-10T09:47:00.000Z",
        dryRun: false,
      }),
    });

    const row = database.prepare("SELECT details_json FROM heartbeats").get() as {
      details_json: string;
    };
    expect(JSON.parse(row.details_json)).toMatchObject({
      trigger: "systemd-timer",
      timerUnit: "precos-daily.timer",
      runIds: ["run-a"],
    });
  });

  it("does not record a completion heartbeat for a dry run", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);

    const summary = await runDaily({ database, dryRun: true, collect: async () => ({
      id: "dry-run",
      retailerId: "retailer-1",
      stage: "collect",
      attempted: 0,
      ok: 0,
      failed: 0,
      successRate: 0,
      status: "completed",
      startedAt: "2026-07-10T06:00:00.000Z",
      finishedAt: "2026-07-10T06:00:00.000Z",
      dryRun: true,
    }) });

    expect(summary.heartbeatRecorded).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS n FROM heartbeats").get()).toEqual({ n: 0 });
  });

  it("fails degraded and emits no heartbeat when no retailer is active", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);

    await expect(runDaily({ database })).rejects.toBeInstanceOf(NoActiveRetailersError);
    expect(database.prepare("SELECT COUNT(*) AS n FROM heartbeats").get()).toEqual({ n: 0 });
  });

  it("monitors each collection only after that run is terminal", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database, "a");
    seedRetailer(database, "b");
    const order: string[] = [];

    await runDaily({
      database,
      collect: async (retailerId) => {
        order.push(`collect-${retailerId}`);
        return {
          id: `run-${retailerId}`,
          retailerId,
          stage: "collect",
          attempted: 1,
          ok: 1,
          failed: 0,
          successRate: 1,
          status: "completed",
          startedAt: "2026-07-10T06:00:00.000Z",
          finishedAt: "2026-07-10T06:00:01.000Z",
          dryRun: false,
        };
      },
      monitor: async (runId) => {
        order.push(`monitor-${runId}`);
      },
    });

    expect(order).toEqual([
      "collect-a",
      "monitor-run-a",
      "collect-b",
      "monitor-run-b",
    ]);
  });

  it("continues deterministic collection and records the heartbeat when monitoring fails", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database, "a");
    seedRetailer(database, "b");
    const collected: string[] = [];

    const summary = await runDaily({
      database,
      collect: async (retailerId) => {
        collected.push(retailerId);
        return {
          id: `run-${retailerId}`,
          retailerId,
          stage: "collect",
          attempted: 1,
          ok: 1,
          failed: 0,
          successRate: 1,
          status: "completed",
          startedAt: "2026-07-10T06:00:00.000Z",
          finishedAt: "2026-07-10T06:00:01.000Z",
          dryRun: false,
        };
      },
      monitor: async (runId) => {
        if (runId === "run-a") throw new Error("monitor fixture failure");
      },
    });

    expect(collected).toEqual(["a", "b"]);
    expect(summary.monitorFailedRunIds).toEqual(["run-a"]);
    expect(summary.heartbeatRecorded).toBe(true);
    const heartbeat = database.prepare(
      "SELECT details_json FROM heartbeats",
    ).get() as { details_json: string };
    expect(JSON.parse(heartbeat.details_json)).toMatchObject({
      monitorFailedRunIds: ["run-a"],
    });
  });
});
