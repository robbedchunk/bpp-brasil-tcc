import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../../../../src/config.js";
import { monthlyModelBudgetUsdFromEnv } from "../../../../src/ops/budget.js";

export interface ControlRoomConfig {
  packageRoot: string;
  projectRoot: string;
  databasePath: string;
  host: "127.0.0.1";
  port: number;
  actionsEnabled: boolean;
  development: boolean;
  staticRoot: string;
  openaiConfigured: boolean;
  notificationConfigured: boolean;
  modelBudgetLimitUsd: number | null;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined || value.trim() === "" ? 4318 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("CONTROL_ROOM_PORT must be an integer from 1024 to 65535");
  }
  return port;
}

function optionalMonthlyModelBudgetUsd(env: NodeJS.ProcessEnv): number | null {
  const value = env.PRECOS_MONTHLY_MODEL_USD?.trim();
  return value === undefined || value === "" ? null : monthlyModelBudgetUsdFromEnv(env);
}

export function loadControlRoomConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): ControlRoomConfig {
  const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const projectRoot = resolve(env.PROJECT_ROOT?.trim() || resolve(packageRoot, "../.."));
  const appConfig = loadConfig({ ...env, PROJECT_ROOT: projectRoot });
  const requestedHost = env.CONTROL_ROOM_HOST?.trim() || "127.0.0.1";
  if (requestedHost !== "127.0.0.1") {
    throw new Error("BPP Control Room binds only to 127.0.0.1");
  }

  return {
    packageRoot,
    projectRoot: appConfig.projectRoot,
    databasePath: appConfig.databasePath,
    host: "127.0.0.1",
    port: parsePort(env.CONTROL_ROOM_PORT),
    actionsEnabled: argv.includes("--enable-actions"),
    development: env.CONTROL_ROOM_DEV === "1",
    staticRoot: resolve(packageRoot, "dist/web"),
    openaiConfigured: appConfig.openaiApiKey !== undefined,
    notificationConfigured: appConfig.ntfyTopic !== undefined,
    modelBudgetLimitUsd: optionalMonthlyModelBudgetUsd(env),
  };
}
