import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface AppConfig {
  databasePath: string;
  projectRoot: string;
  timezone: "America/Sao_Paulo";
  pageConcurrency: number;
  dailyPageCap: number;
  openaiApiKey?: string;
  ntfyTopic?: string;
}

const DEFAULT_PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === "" ? undefined : normalized;
}

function integerInRange(
  name: string,
  rawValue: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = rawValue === undefined || rawValue.trim() === ""
    ? defaultValue
    : Number(rawValue);

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const projectRoot = resolve(optionalValue(env.PROJECT_ROOT) ?? DEFAULT_PROJECT_ROOT);
  const configuredDatabasePath = optionalValue(env.DATABASE_PATH);
  const openaiApiKey = optionalValue(env.OPENAI_API_KEY);
  const ntfyTopic = optionalValue(env.NTFY_TOPIC);

  return {
    projectRoot,
    databasePath: resolve(projectRoot, configuredDatabasePath ?? "data/precos.sqlite"),
    timezone: "America/Sao_Paulo",
    pageConcurrency: integerInRange("PAGE_CONCURRENCY", env.PAGE_CONCURRENCY, 4, 3, 5),
    dailyPageCap: integerInRange("DAILY_PAGE_CAP", env.DAILY_PAGE_CAP, 2_000, 1, 2_000),
    ...(openaiApiKey === undefined ? {} : { openaiApiKey }),
    ...(ntfyTopic === undefined ? {} : { ntfyTopic }),
  };
}
