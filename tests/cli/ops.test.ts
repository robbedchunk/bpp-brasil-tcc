import { afterEach, describe, expect, it } from "vitest";

import { buildCli, type CliDependencies } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";
import { recordHeartbeat } from "../../src/ops/heartbeat.js";
import type { AlertEvent } from "../../src/ops/alerts.js";

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

async function run(
  dependencies: CliDependencies,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const cli = buildCli({
    ...dependencies,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  await cli.parseAsync(["node", "precos", "heartbeat", "check", "--json"]);
  return { stdout, stderr };
}

describe("heartbeat CLI", () => {
  it("alerts on stale heartbeat without exposing external state", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const alerts: AlertEvent[] = [];

    const result = await run({
      database,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({ stale: true, lastSuccessAt: null });
    expect(alerts).toHaveLength(1);
    expect(result.stderr).toBe("");
  });

  it("does not alert when the latest heartbeat is fresh", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    recordHeartbeat(database, {
      pipeline: "collect",
      scheduledFor: "2026-07-10T06:00:00.000Z",
      completedAt: "2026-07-10T06:05:00.000Z",
      details: scheduledDetails,
    });
    const alerts: AlertEvent[] = [];

    const result = await run({
      database,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({ stale: false });
    expect(alerts).toEqual([]);
  });

  it("does not let a fresh manual heartbeat conceal a stale scheduled run", async () => {
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
      scheduledFor: "2026-07-10T11:00:00.000Z",
      completedAt: "2026-07-10T11:05:00.000Z",
      details: { trigger: "manual" },
    });
    const alerts: AlertEvent[] = [];

    const result = await run({
      database,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({ stale: true });
    expect(alerts).toHaveLength(1);
  });
});
