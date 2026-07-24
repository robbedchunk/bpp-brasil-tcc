import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { controlCapabilities } from "../../../../src/control/capabilities.js";
import { inspectProcessLock } from "../../../../src/ops/lock.js";
import type { SystemResponse } from "../shared/contracts.js";
import type { ControlRoomConfig } from "./config.js";
import type { DatabaseInspection } from "./read-model/database.js";

const execFileAsync = promisify(execFile);

const InstallationSchema = z.object({
  schemaVersion: z.number().int().positive(),
  scheduleActivatedAt: z.string().optional(),
  deployedAt: z.string(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  releaseId: z.string().regex(/^[a-f0-9]{32,64}$/u),
  units: z.array(z.object({
    name: z.string().regex(/^precos-[a-z-]+\.(?:service|timer)$/u),
  })),
});

async function checkoutState(projectRoot: string): Promise<SystemResponse["checkout"]> {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
        timeout: 3_000,
      }),
      execFileAsync("git", ["-C", projectRoot, "status", "--porcelain"], {
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 1_000_000,
      }),
    ]);
    const normalized = commit.trim();
    return {
      commit: /^[a-f0-9]{40}$/u.test(normalized) ? normalized : null,
      dirty: status.trim() !== "",
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

async function installationState(projectRoot: string): Promise<SystemResponse["installedRelease"]> {
  try {
    const value = InstallationSchema.parse(JSON.parse(await readFile(
      resolve(projectRoot, "var/operations/systemd-install.json"),
      "utf8",
    )));
    return {
      available: true,
      releaseId: value.releaseId,
      sourceCommit: value.sourceCommit,
      deployedAt: value.deployedAt,
      scheduleActivatedAt: value.scheduleActivatedAt ?? null,
      unitCount: value.units.length,
    };
  } catch {
    return {
      available: false,
      releaseId: null,
      sourceCommit: null,
      deployedAt: null,
      scheduleActivatedAt: null,
      unitCount: 0,
    };
  }
}

export async function readSystemState(
  config: ControlRoomConfig,
  database: DatabaseInspection,
  now: () => Date = () => new Date(),
): Promise<SystemResponse> {
  const lockDefinitions = [
    ["pipeline", "var/precos-pipeline.lock"],
    ["explorer", "var/precos-explorer.lock"],
    ["classification", "var/precos-classification.lock"],
    ["index", "var/precos-index.lock"],
  ] as const;
  const [checkout, installedRelease, ...locks] = await Promise.all([
    checkoutState(config.projectRoot),
    installationState(config.projectRoot),
    ...lockDefinitions.map(async ([name, path]) => {
      const inspection = await inspectProcessLock(resolve(config.projectRoot, path));
      return {
        name,
        state: inspection.state,
        blocksAcquisition: inspection.blocksAcquisition,
        startedAt: inspection.startedAt ?? null,
        ageMs: inspection.ageMs ?? null,
      };
    }),
  ]);
  const capabilities = controlCapabilities();
  return {
    generatedAt: now().toISOString(),
    database: {
      label: database.label,
      state: database.state,
      schemaCapability: database.schemaCapability,
    },
    capabilities: {
      protocolVersion: capabilities.protocolVersion,
      actionsEnabled: config.actionsEnabled,
      openaiConfigured: config.openaiConfigured,
      notificationConfigured: config.notificationConfigured,
    },
    checkout,
    installedRelease,
    locks,
  };
}
