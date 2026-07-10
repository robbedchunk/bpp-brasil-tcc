import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import {
  checkHeartbeat,
  latestSuccessfulHeartbeat,
  recordHeartbeat,
} from "../../src/ops/heartbeat.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("heartbeat", () => {
  it("marks a last success older than 24 hours stale", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const lastSuccess25HoursAgo = new Date("2026-07-09T11:00:00.000Z");

    expect(checkHeartbeat(now, lastSuccess25HoursAgo)).toMatchObject({ stale: true });
    expect(checkHeartbeat(now, new Date("2026-07-09T13:00:01.000Z")))
      .toMatchObject({ stale: false });
  });

  it("records an immutable completed heartbeat", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    recordHeartbeat(database, {
      pipeline: "collect",
      scheduledFor: "2026-07-10T06:00:00.000Z",
      completedAt: "2026-07-10T06:05:00.000Z",
      details: { retailers: 2 },
    });

    expect(latestSuccessfulHeartbeat(database, "collect")).toEqual(
      new Date("2026-07-10T06:05:00.000Z"),
    );
  });
});
