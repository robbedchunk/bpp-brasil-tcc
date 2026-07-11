import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCli, type CliDependencies } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";
import { withProcessLock } from "../../src/ops/lock.js";
import type { RunSummary } from "../../src/pipeline/discover.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function summary(retailerId: string, stage: "discover" | "collect"): RunSummary {
  return {
    id: `${stage}-${retailerId}`,
    retailerId,
    stage,
    attempted: 1,
    ok: 1,
    failed: 0,
    successRate: 1,
    status: "completed",
    startedAt: "2026-07-10T06:00:00.000Z",
    finishedAt: "2026-07-10T06:00:01.000Z",
    dryRun: true,
  };
}

async function invoke(
  arguments_: string[],
  dependencies: CliDependencies,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const cli = buildCli({
    ...dependencies,
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

describe("pipeline CLI", () => {
  it("wires discover flags and clamps an excessive limit", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    database.prepare(
      `INSERT INTO retailers (id, name, base_url, cep, domains_json)
       VALUES ('r1', 'R1', 'https://r1.test', '01310-100', '["r1.test"]')`,
    ).run();
    const calls: unknown[] = [];

    const result = await invoke(
      ["discover", "--retailer", "r1", "--limit", "9000", "--dry-run", "--json"],
      {
        databasePath: ":memory:",
        database,
        runDiscovery: async (retailerId, options) => {
          calls.push({ retailerId, options });
          return summary(retailerId, "discover");
        },
      },
    );

    expect(calls).toEqual([{ retailerId: "r1", options: { limit: 3_000, dryRun: true } }]);
    expect(JSON.parse(result.stdout)).toMatchObject([{ stage: "discover", retailerId: "r1" }]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  });

  it("runs collection for all active retailers when retailer is omitted", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    database.exec(`
      INSERT INTO retailers (id, name, base_url, cep, domains_json, active) VALUES
        ('a', 'A', 'https://a.test', '01310-100', '["a.test"]', 1),
        ('b', 'B', 'https://b.test', '01310-100', '["b.test"]', 1),
        ('off', 'Off', 'https://off.test', '01310-100', '["off.test"]', 0)
    `);
    const calls: string[] = [];

    const result = await invoke(["collect", "--limit", "30", "--json"], {
      databasePath: ":memory:",
      database,
      runCollection: async (retailerId) => {
        calls.push(retailerId);
        return summary(retailerId, "collect");
      },
    });

    expect(calls).toEqual(["a", "b"]);
    expect(JSON.parse(result.stdout)).toHaveLength(2);
  });

  it("emits the durable daily summary but exits nonzero for a partial operational boundary", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const result = await invoke(["daily", "--json"], {
      database,
      databasePath: ":memory:",
      lockPath: join(tmpdir(), `precos-daily-partial-${randomUUID()}.lock`),
      alertSink: { async send() {} },
      runDaily: async () => ({
        status: "partial",
        startedAt: "2026-07-10T06:00:00.000Z",
        finishedAt: "2026-07-10T06:01:00.000Z",
        retailers: 2,
        terminal: 1,
        heartbeatRecorded: true,
        monitorFailedRunIds: [],
        retailerFailures: [{ retailerId: "b", message: "fixture failure" }],
        runs: [summary("a", "collect")],
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "partial",
      retailerFailures: [{ retailerId: "b" }],
    });
  });

  it("wires the private replay re-extraction command to an audited workflow", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    let received: unknown;
    const result = await invoke([
      "replay-reextract",
      "--observation",
      "observation-1",
      "--json",
    ], {
      database,
      lockPath: join(tmpdir(), `replay-reextract-${randomUUID()}.lock`),
      env: { ...process.env, PROJECT_ROOT: "/tmp/replay-private-project" },
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      replayReextract: async (options) => {
        received = options;
        return {
          id: "audit-1",
          observationId: options.observationId,
          retailerId: "retailer-1",
          productId: "product-1",
          strategyId: "strategy-1",
          strategyVersion: 1,
          status: "succeeded",
          executedAt: "2026-07-11T12:00:00.000Z",
          result: {
            ok: true,
            fields: {
              title: "Arroz tipo 1 pacote 5 kg",
              brand: null,
              price: 10,
              promoPrice: null,
              unit: "5 kg",
              available: true,
            },
          },
        };
      },
    });

    expect(received).toMatchObject({
      database,
      observationId: "observation-1",
      replayRoot: "/tmp/replay-private-project/data/raw-html",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "audit-1", status: "succeeded" });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  });

  it("returns TEMPFAIL when private re-extraction contends with the pipeline lock", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const lockPath = join(tmpdir(), `replay-reextract-contention-${randomUUID()}.lock`);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = withProcessLock(lockPath, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let calls = 0;
    const dependencies: CliDependencies = {
      database,
      lockPath,
      env: { ...process.env, PROJECT_ROOT: "/tmp/replay-private-project" },
      replayReextract: async () => {
        calls += 1;
        throw new Error("fixture should not execute while locked");
      },
    };

    const blocked = await invoke([
      "replay-reextract", "--observation", "observation-1", "--json",
    ], dependencies);
    expect(blocked.exitCode).toBe(75);
    expect(calls).toBe(0);

    release.resolve();
    await owner;
  });
});
