import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const INVOCATION_ID = /^[a-f0-9]{32}$/u;
const RELEASE_ID = /^[a-f0-9]{32}$/u;
const DAILY_SERVICE = "precos-daily.service";
const DAILY_TIMER = "precos-daily.timer";

export interface ScheduledDailyInvocation {
  provenanceVersion: 1;
  trigger: "systemd-timer";
  serviceUnit: typeof DAILY_SERVICE;
  timerUnit: typeof DAILY_TIMER;
  invocationId: string;
  cgroupSha256: string;
  releaseId: string;
  timerLastTriggerAt: string;
  serviceStartedAt: string;
  timerCausalitySha256: string;
}

function properties(output: string): Map<string, string> {
  return new Map(output.trim().split("\n").filter(Boolean).map((line) => {
    const split = line.indexOf("=");
    return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
  }));
}

function nativeSystemdProperties(): { service: string; timer: string } {
  return {
    service: execFileSync("systemctl", [
      "--user", "show", DAILY_SERVICE,
      "--property=InvocationID,ExecMainStartTimestamp",
      "--no-pager",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    timer: execFileSync("systemctl", [
      "--user", "show", DAILY_TIMER,
      "--property=LastTriggerUSec",
      "--no-pager",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
  };
}

function hasExactUnitCgroup(raw: string): boolean {
  return raw.split("\n").some((line) => {
    if (line === "") return false;
    const secondColon = line.indexOf(":", line.indexOf(":") + 1);
    if (secondColon < 0) return false;
    const path = line.slice(secondColon + 1);
    const lastSegment = path.split("/").filter(Boolean).at(-1);
    return lastSegment === DAILY_SERVICE;
  });
}

/**
 * Converts systemd's process-scoped credentials into immutable heartbeat
 * provenance. Merely setting PRECOS_SCHEDULE_SOURCE is never sufficient.
 */
export function readScheduledDailyInvocation(
  environment: NodeJS.ProcessEnv,
  readCgroup: () => Buffer = () => readFileSync("/proc/self/cgroup"),
  readSystemdProperties: () => { service: string; timer: string } = nativeSystemdProperties,
): ScheduledDailyInvocation | null {
  const source = environment.PRECOS_SCHEDULE_SOURCE;
  if (source === undefined || source === "") return null;
  if (source !== "systemd-timer") {
    throw new Error("PRECOS_SCHEDULE_SOURCE must be unset or systemd-timer");
  }
  const invocationId = environment.INVOCATION_ID;
  const releaseId = environment.PRECOS_RELEASE_ID;
  if (invocationId === undefined || !INVOCATION_ID.test(invocationId)) {
    throw new Error("Scheduled daily execution requires systemd INVOCATION_ID");
  }
  if (releaseId === undefined || !RELEASE_ID.test(releaseId)) {
    throw new Error("Scheduled daily execution requires a frozen PRECOS_RELEASE_ID");
  }
  const cgroup = readCgroup();
  if (cgroup.length === 0 || cgroup.length > 64 * 1_024 || !hasExactUnitCgroup(cgroup.toString("utf8"))) {
    throw new Error(`Scheduled daily execution is not running in ${DAILY_SERVICE}`);
  }
  const systemd = readSystemdProperties();
  const service = properties(systemd.service);
  const timer = properties(systemd.timer);
  const serviceInvocationId = service.get("InvocationID");
  const serviceStartedMs = Date.parse(service.get("ExecMainStartTimestamp") ?? "");
  const timerLastTriggerMs = Date.parse(timer.get("LastTriggerUSec") ?? "");
  if (serviceInvocationId !== invocationId
    || !Number.isFinite(serviceStartedMs) || !Number.isFinite(timerLastTriggerMs)
    || Math.abs(serviceStartedMs - timerLastTriggerMs) > 1_000
    || timerLastTriggerMs > Date.now() + 1_000) {
    throw new Error(`Scheduled daily execution is not causally matched to ${DAILY_TIMER}`);
  }
  const serviceStartedAt = new Date(serviceStartedMs).toISOString();
  const timerLastTriggerAt = new Date(timerLastTriggerMs).toISOString();
  const timerCausalitySha256 = createHash("sha256").update(JSON.stringify({
    invocationId,
    serviceStartedAt,
    serviceUnit: DAILY_SERVICE,
    timerLastTriggerAt,
    timerUnit: DAILY_TIMER,
  })).digest("hex");
  return {
    provenanceVersion: 1,
    trigger: "systemd-timer",
    serviceUnit: DAILY_SERVICE,
    timerUnit: DAILY_TIMER,
    invocationId,
    cgroupSha256: createHash("sha256").update(cgroup).digest("hex"),
    releaseId,
    timerLastTriggerAt,
    serviceStartedAt,
    timerCausalitySha256,
  };
}
