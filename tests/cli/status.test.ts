import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCli, type CliDependencies } from "../../src/cli.js";
import { openDatabase } from "../../src/db/database.js";

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "precos-status-"));
  temporaryDirectories.push(directory);
  return join(directory, "precos.sqlite");
}

async function runCli(
  arguments_: string[],
  dependencies: Pick<CliDependencies, "databasePath" | "now">,
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const command = buildCli({
    ...dependencies,
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
  });

  command.exitOverride();
  try {
    await command.parseAsync(["node", "precos", ...arguments_]);
    return { exitCode: 0, stderr, stdout };
  } catch (error) {
    const exitCode =
      typeof error === "object" && error !== null && "exitCode" in error
        ? Number(error.exitCode)
        : 1;
    return { exitCode, stderr, stdout };
  }
}

describe("precos status", () => {
  it("prints a valid empty status report", async () => {
    const databasePath = await temporaryDatabasePath();
    const result = await runCli(["status", "--json"], {
      databasePath,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      retailers: [],
      staleHeartbeat: true,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("reports each retailer's latest collection run and fresh heartbeat", async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openDatabase(databasePath);
    database
      .prepare(
        `INSERT INTO retailers
           (id, name, base_url, cep, domains_json, active, degraded)
         VALUES
           ('retailer-1', 'Mercado Teste', 'https://mercado.example',
            '01310-100', '["mercado.example"]', 1, 0)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO runs
           (id, retailer_id, stage, collection_day, status, attempted, ok, failed,
            started_at, finished_at)
         VALUES
           ('run-1', 'retailer-1', 'collect', '2026-07-09', 'completed', 10, 9, 1,
            '2026-07-09T06:00:00.000Z', '2026-07-09T06:05:00.000Z'),
           ('run-2', 'retailer-1', 'collect', '2026-07-10', 'completed', 20, 18, 2,
            '2026-07-10T06:00:00.000Z', '2026-07-10T06:05:00.000Z')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO heartbeats
           (id, pipeline, retailer_id, scheduled_for, completed_at, status)
         VALUES
           ('heartbeat-1', 'collect', 'retailer-1', '2026-07-10T06:00:00.000Z',
            '2026-07-10T06:05:00.000Z', 'completed')`,
      )
      .run();
    database.close();

    const result = await runCli(["status", "--json"], {
      databasePath,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(JSON.parse(result.stdout)).toEqual({
      generatedAt: "2026-07-10T12:00:00.000Z",
      staleHeartbeat: false,
      retailers: [
        {
          id: "retailer-1",
          name: "Mercado Teste",
          active: true,
          degraded: false,
          latestRun: {
            collectionDay: "2026-07-10",
            attempted: 20,
            ok: 18,
            failed: 2,
            successRate: 0.9,
          },
        },
      ],
    });
    expect(result.exitCode).toBe(0);
  });

  it("prints a compact human-readable table without network activity", async () => {
    const databasePath = await temporaryDatabasePath();
    const result = await runCli(["status"], {
      databasePath,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(result.stdout).toContain("RETAILER");
    expect(result.stdout).toContain("HEARTBEAT  STALE");
    expect(result.stdout).toContain("(no retailers)");
    expect(result.exitCode).toBe(0);
  });

  it("initializes the database idempotently through the CLI", async () => {
    const databasePath = await temporaryDatabasePath();

    expect((await runCli(["db", "init"], { databasePath })).exitCode).toBe(0);
    expect((await runCli(["db", "init"], { databasePath })).exitCode).toBe(0);

    const database = openDatabase(databasePath);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 7 });
    database.close();
  });
});
