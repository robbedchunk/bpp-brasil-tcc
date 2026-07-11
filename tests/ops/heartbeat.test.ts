import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import {
  checkHeartbeat,
  latestSuccessfulHeartbeat,
  recordHeartbeat,
} from "../../src/ops/heartbeat.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

const scheduledDetails = {
  provenanceVersion: 1,
  trigger: "systemd-timer",
  serviceUnit: "precos-daily.service",
  timerUnit: "precos-daily.timer",
  invocationId: "a".repeat(32),
  cgroupSha256: "b".repeat(64),
  releaseId: "c".repeat(32),
  timerLastTriggerAt: "2026-07-10T06:00:00.000Z",
  serviceStartedAt: "2026-07-10T06:00:00.000Z",
  timerCausalitySha256: "b86ba89e8105bea1281932a48880f8dc3ca784e6100932b29db415977b575197",
};

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

  it("can select only timer-provenanced daily heartbeats", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    recordHeartbeat(database, {
      pipeline: "collect",
      scheduledFor: "2026-07-09T06:00:00.000Z",
      completedAt: "2026-07-09T06:05:00.000Z",
      details: scheduledDetails,
    });
    recordHeartbeat(database, {
      pipeline: "collect",
      scheduledFor: "2026-07-10T06:00:00.000Z",
      completedAt: "2026-07-10T06:05:00.000Z",
      details: { trigger: "manual" },
    });

    expect(latestSuccessfulHeartbeat(database, "collect", { scheduledOnly: true })).toEqual(
      new Date("2026-07-09T06:05:00.000Z"),
    );
  });

  it("never lets operational-failure details masquerade as a successful heartbeat", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    recordHeartbeat(database, {
      pipeline: "collect",
      scheduledFor: "2026-07-09T06:00:00.000Z",
      completedAt: "2026-07-09T06:05:00.000Z",
      details: {
        ...scheduledDetails,
        monitorFailedRunIds: [],
        retailerFailures: [],
      },
    });
    recordHeartbeat(database, {
      pipeline: "collect",
      scheduledFor: "2026-07-10T06:00:00.000Z",
      completedAt: "2026-07-10T06:05:00.000Z",
      details: {
        ...scheduledDetails,
        monitorFailedRunIds: ["run-failed-monitor"],
        retailerFailures: [],
      },
    });

    expect(latestSuccessfulHeartbeat(database, "collect", { scheduledOnly: true })).toEqual(
      new Date("2026-07-09T06:05:00.000Z"),
    );
  });
});
