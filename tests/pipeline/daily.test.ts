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
});
