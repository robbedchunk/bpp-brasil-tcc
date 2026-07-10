import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCli, type CliDependencies } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";
import type { AlertEvent } from "../../src/ops/alerts.js";
import { extractionStrategy, seedRetailer, seedStrategy } from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function databaseFixture() {
  const database = openDatabase(":memory:");
  databases.push(database);
  seedRetailer(database);
  seedStrategy(database, "extraction", extractionStrategy);
  return database;
}

async function invoke(
  arguments_: string[],
  dependencies: CliDependencies,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const cli = buildCli({
    ...dependencies,
    lockPath: dependencies.lockPath ?? join(tmpdir(), `explore-cli-${randomUUID()}.lock`),
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  cli.exitOverride();
  try {
    await cli.parseAsync(["node", "precos", ...arguments_]);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout,
      stderr,
      exitCode: typeof error === "object" && error !== null && "exitCode" in error
        ? Number(error.exitCode)
        : 1,
    };
  }
}

describe("explore CLI", () => {
  it("reports provider_unavailable and alerts without a configured key", async () => {
    const database = databaseFixture();
    const alerts: AlertEvent[] = [];
    let sawGenerator = true;

    const result = await invoke([
      "explore",
      "--retailer",
      "retailer-1",
      "--purpose",
      "extraction",
      "--json",
    ], {
      database,
      env: {},
      alertSink: { send: async (event) => { alerts.push(event); } },
      exploreRetailer: async (_retailerId, _purpose, dependencies) => {
        sawGenerator = dependencies.generator !== undefined;
        return {
          explorationRunId: "explore-no-key",
          activated: false,
          attempts: 1,
          externalScore: null,
          outcome: "provider_unavailable",
          costUsd: 0,
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "provider_unavailable",
      activated: false,
    });
    expect(sawGenerator).toBe(false);
    expect(alerts).toHaveLength(1);
  });

  it("runs an explicitly injected offline fixture generator without credentials", async () => {
    const database = databaseFixture();
    const generator = { generate: async () => { throw new Error("not called by wiring test"); } };
    let receivedGenerator: unknown;

    const result = await invoke([
      "explore",
      "--retailer",
      "retailer-1",
      "--json",
    ], {
      database,
      env: {},
      strategyGenerator: generator,
      exploreRetailer: async (_retailerId, _purpose, dependencies) => {
        receivedGenerator = dependencies.generator;
        return {
          explorationRunId: "explore-ok",
          activated: true,
          attempts: 1,
          externalScore: 0.9,
          outcome: "activated",
          costUsd: 0.01,
          strategyId: "strategy-v2",
          strategyVersion: 2,
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(receivedGenerator).toBe(generator);
  });
});
