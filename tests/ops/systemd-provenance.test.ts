import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { readScheduledDailyInvocation } from "../../src/ops/systemd-provenance.js";

describe("scheduled systemd provenance", () => {
  const environment = {
    PRECOS_SCHEDULE_SOURCE: "systemd-timer",
    PRECOS_RELEASE_ID: "b".repeat(32),
    INVOCATION_ID: "a".repeat(32),
  };

  it("binds an exact daily service cgroup, invocation, and frozen release", () => {
    const cgroup = Buffer.from("0::/user.slice/user-1000.slice/user@1000.service/app.slice/precos-daily.service\n");
    const systemd = () => ({
      service: `InvocationID=${"a".repeat(32)}\nExecMainStartTimestamp=2026-07-11T09:00:00.000Z\n`,
      timer: "LastTriggerUSec=2026-07-11T09:00:00.000Z\n",
    });
    expect(readScheduledDailyInvocation(environment, () => cgroup, systemd)).toEqual({
      provenanceVersion: 1,
      trigger: "systemd-timer",
      serviceUnit: "precos-daily.service",
      timerUnit: "precos-daily.timer",
      invocationId: "a".repeat(32),
      cgroupSha256: createHash("sha256").update(cgroup).digest("hex"),
      releaseId: "b".repeat(32),
      timerLastTriggerAt: "2026-07-11T09:00:00.000Z",
      serviceStartedAt: "2026-07-11T09:00:00.000Z",
      timerCausalitySha256: createHash("sha256").update(JSON.stringify({
        invocationId: "a".repeat(32),
        serviceStartedAt: "2026-07-11T09:00:00.000Z",
        serviceUnit: "precos-daily.service",
        timerLastTriggerAt: "2026-07-11T09:00:00.000Z",
        timerUnit: "precos-daily.timer",
      })).digest("hex"),
    });
  });

  it("treats an ordinary invocation as manual", () => {
    expect(readScheduledDailyInvocation({}, () => { throw new Error("must not read cgroup"); }))
      .toBeNull();
  });

  it.each([
    [{ ...environment, INVOCATION_ID: "a".repeat(31) }, "0::/precos-daily.service\n"],
    [{ ...environment, PRECOS_RELEASE_ID: "b".repeat(31) }, "0::/precos-daily.service\n"],
    [environment, "0::/precos-daily.service.evil\n"],
    [environment, "0::/precos-daily.service/child.scope\n"],
    [{ ...environment, PRECOS_SCHEDULE_SOURCE: "cron" }, "0::/precos-daily.service\n"],
  ])("fails closed for forged or incomplete provenance", (env, cgroup) => {
    expect(() => readScheduledDailyInvocation(
      env,
      () => Buffer.from(cgroup),
      () => ({
        service: `InvocationID=${"a".repeat(32)}\nExecMainStartTimestamp=2026-07-11T09:00:00.000Z\n`,
        timer: "LastTriggerUSec=2026-07-11T09:00:00.000Z\n",
      }),
    )).toThrow();
  });

  it("rejects an indirect service activation that did not come from the timer", () => {
    const cgroup = Buffer.from("0::/app.slice/precos-daily.service\n");
    expect(() => readScheduledDailyInvocation(environment, () => cgroup, () => ({
      service: `InvocationID=${"a".repeat(32)}\nExecMainStartTimestamp=2026-07-11T09:05:00.000Z\n`,
      timer: "LastTriggerUSec=2026-07-11T09:00:00.000Z\n",
    }))).toThrow(/causally matched/u);
  });
});
