import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCli, type CliDependencies } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";
import { beginHealingEvent } from "../../src/db/repositories.js";
import type { AlertEvent } from "../../src/ops/alerts.js";
import { withProcessLock } from "../../src/ops/lock.js";
import { extractionStrategy, seedRetailer, seedStrategy } from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const directories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function seedDrift() {
  const database = openDatabase(":memory:");
  databases.push(database);
  seedRetailer(database);
  seedStrategy(database, "extraction", extractionStrategy);
  database.prepare(
    `INSERT INTO runs
       (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
        status, attempted, ok, failed, started_at, finished_at)
     VALUES ('drift-run', 'retailer-1', 'collect', '2026-07-10',
             'retailer-1-extraction-v1', 1, 'running', 0, 0, 0,
             '2026-07-10T00:00:00.000Z', NULL)`,
  ).run();
  database.prepare(
    `INSERT INTO run_failures
       (id, run_id, retailer_id, category, responded, message, strategy_id,
        strategy_version, occurred_at)
     VALUES ('failure-1', 'drift-run', 'retailer-1', 'missing-fields', 1,
             'fixture drift', 'retailer-1-extraction-v1', 1,
             '2026-07-10T00:00:30.000Z')`,
  ).run();
  database.prepare(`
    UPDATE runs SET status = 'failed', attempted = 1, failed = 1,
                    finished_at = '2026-07-10T00:01:00.000Z'
    WHERE id = 'drift-run'
  `).run();
  return database;
}

async function invoke(
  arguments_: string[],
  dependencies: CliDependencies,
  useDefaultLock = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const cli = buildCli({
    ...dependencies,
    ...(useDefaultLock
      ? {}
      : { lockPath: dependencies.lockPath ?? join(tmpdir(), `healing-cli-${randomUUID()}.lock`) }),
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

describe("heal CLI", () => {
  it("defers behind the real daily lock with TEMPFAIL and succeeds on retry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "healing-shared-lock-"));
    directories.push(projectRoot);
    const pipelineLock = join(projectRoot, "var", "precos-pipeline.lock");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = withProcessLock(pipelineLock, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let workerCalls = 0;
    const database = seedDrift();
    const dependencies: CliDependencies = {
      database,
      env: { PROJECT_ROOT: projectRoot },
      healPendingEvents: async () => {
        workerCalls += 1;
        return {
          queued: 0,
          processed: 0,
          recovered: 0,
          failed: 0,
          deferred: 0,
          providerUnavailable: 0,
          superseded: 0,
          inProgress: 0,
          workerErrors: 0,
        };
      },
    };

    const blocked = await invoke(["heal", "--pending", "--json"], dependencies, true);
    expect(blocked.exitCode).toBe(75);
    expect(workerCalls).toBe(0);

    release.resolve();
    await owner;
    const retried = await invoke(["heal", "--pending", "--json"], dependencies, true);
    expect(retried.exitCode).toBe(0);
    expect(workerCalls).toBe(1);
  });

  it("documents extraction-only healing and rejects the discovery option", async () => {
    const cli = buildCli();
    const heal = cli.commands.find((command) => command.name() === "heal");
    expect(heal?.helpInformation()).toContain("extraction");
    expect(heal?.helpInformation()).not.toContain("--purpose");

    const result = await invoke([
      "heal",
      "--retailer",
      "retailer-1",
      "--purpose",
      "discovery",
    ], { database: seedDrift() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown option.*--purpose/iu);
  });

  it("records provider-unavailable attempt/event/alert evidence without retiring active strategy", async () => {
    const database = seedDrift();
    const alerts: AlertEvent[] = [];

    const result = await invoke([
      "heal",
      "--retailer",
      "retailer-1",
      "--run",
      "drift-run",
      "--json",
    ], {
      database,
      env: {},
      now: () => new Date("2026-07-10T00:05:00.000Z"),
      alertSink: { send: async (event) => { alerts.push(event); } },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "provider_unavailable",
      activated: false,
    });
    expect(database.prepare("SELECT status FROM healing_events").all())
      .toEqual([{ status: "provider_unavailable" }]);
    expect(database.prepare("SELECT outcome FROM exploration_attempts").all())
      .toEqual([{ outcome: "provider_unavailable" }]);
    expect(database.prepare(
      "SELECT id FROM strategies WHERE retailer_id = 'retailer-1' AND active = 1",
    ).all()).toEqual([{ id: "retailer-1-extraction-v1" }]);
    expect(alerts).toHaveLength(1);
  });

  it("processes queued events through heal --pending", async () => {
    const database = seedDrift();
    beginHealingEvent(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      onsetRunId: "drift-run",
      detectedAt: "2026-07-10T00:00:00.000Z",
    });

    const result = await invoke(["heal", "--pending", "--json"], {
      database,
      env: {},
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      alertSink: { send: async () => {} },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      processed: 1,
      providerUnavailable: 1,
    });
    expect(database.prepare("SELECT status FROM healing_events").get())
      .toEqual({ status: "provider_unavailable" });
  });
});
