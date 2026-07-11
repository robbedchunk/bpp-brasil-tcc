import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import {
  admitDiscoveryReference,
  admitReplaySlot,
  admitRequest,
  createRun,
  requestAdmissionsForStageOnDay,
} from "../../src/db/repositories.js";
import {
  discoveryStrategy,
  extractionStrategy,
  seedRetailer,
  seedStrategy,
} from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const directories: string[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function createStrategyRun(
  database: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    stage: "discover" | "collect";
    day?: string;
  },
): void {
  createRun(database, {
    id: input.id,
    retailerId: "retailer-1",
    stage: input.stage,
    collectionDay: input.day ?? "2026-07-10",
    strategyId: input.stage === "discover"
      ? "retailer-1-discovery-v1"
      : "retailer-1-extraction-v1",
    strategyVersion: 1,
    startedAt: "2026-07-10T12:00:00.000Z",
  });
}

function fillAdmissions(
  database: ReturnType<typeof openDatabase>,
  input: {
    runId: string;
    stage: "discover" | "collect";
    first?: number;
    last: number;
  },
): void {
  const first = input.first ?? 1;
  database.prepare(`
    WITH RECURSIVE ordinals(ordinal) AS (
      VALUES (?)
      UNION ALL
      SELECT ordinal + 1 FROM ordinals WHERE ordinal < ?
    )
    INSERT INTO request_admissions
      (id, run_id, retailer_id, collection_day, stage, stage_ordinal, admitted_at)
    SELECT
      printf('%s-%04d', ?, ordinal), ?, 'retailer-1', '2026-07-10', ?, ordinal,
      '2026-07-10T12:00:00.000Z'
    FROM ordinals
  `).run(first, input.last, `${input.runId}-admission`, input.runId, input.stage);
}

function concurrentAdmissionProcess(
  databasePath: string,
  runId: string,
): Promise<number> {
  const repositoryUrl = pathToFileURL(resolve("src/db/repositories.ts")).href;
  const source = `
    import Database from "better-sqlite3";
    import { admitRequest } from ${JSON.stringify(repositoryUrl)};
    const database = new Database(${JSON.stringify(databasePath)});
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 30000");
    let admitted = 0;
    for (let index = 0; index < 2000; index += 1) {
      const result = admitRequest(database, {
        runId: ${JSON.stringify(runId)},
        retailerId: "retailer-1",
        collectionDay: "2026-07-10",
        stage: "collect",
        admittedAt: "2026-07-10T12:00:00.000Z",
      });
      if (!result.admitted) break;
      admitted += 1;
    }
    database.close();
    process.stdout.write(String(admitted));
  `;
  return new Promise((resolveCount, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      source,
    ], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Admission process exited ${String(code)}: ${stderr}`));
        return;
      }
      resolveCount(Number(stdout));
    });
  });
}

describe("durable request admissions", () => {
  it("atomically limits concurrent processes to 2,000 admissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-request-contention-"));
    directories.push(directory);
    const path = join(directory, "precos.sqlite");
    const database = openDatabase(path);
    seedRetailer(database);
    seedStrategy(database, "extraction", extractionStrategy);
    for (let index = 0; index < 4; index += 1) {
      createStrategyRun(database, { id: `concurrent-${index}`, stage: "collect" });
    }
    database.close();

    const counts = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      concurrentAdmissionProcess(path, `concurrent-${index}`)));

    const verification = openDatabase(path);
    databases.push(verification);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(2_000);
    expect(requestAdmissionsForStageOnDay(
      verification,
      "retailer-1",
      "2026-07-10",
      "collect",
    )).toBe(2_000);
    expect(verification.prepare(`
      SELECT COUNT(DISTINCT stage_ordinal) AS ordinals,
             MIN(stage_ordinal) AS minimum,
             MAX(stage_ordinal) AS maximum
      FROM request_admissions
    `).get()).toEqual({ ordinals: 2_000, minimum: 1, maximum: 2_000 });
  }, 30_000);

  it("keeps a pre-request charge after a crashed run is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-request-crash-"));
    directories.push(directory);
    const path = join(directory, "precos.sqlite");
    const crashed = openDatabase(path);
    seedRetailer(crashed);
    seedStrategy(crashed, "extraction", extractionStrategy);
    createStrategyRun(crashed, { id: "crashed-run", stage: "collect" });
    crashed.prepare(`
      INSERT INTO products
        (id, retailer_id, canonical_url, title, first_seen, last_seen)
      VALUES ('crash-product', 'retailer-1', 'https://shop.test/crash-product',
              'Crash product', '2026-07-10T00:00:00.000Z',
              '2026-07-10T00:00:00.000Z')
    `).run();
    expect(admitRequest(crashed, {
      runId: "crashed-run",
      retailerId: "retailer-1",
      collectionDay: "2026-07-10",
      stage: "collect",
      admittedAt: "2026-07-10T12:00:00.000Z",
    })).toMatchObject({ admitted: true, used: 1, remaining: 1_999 });
    expect(admitReplaySlot(crashed, {
      runId: "crashed-run",
      retailerId: "retailer-1",
      productId: "crash-product",
      collectionDay: "2026-07-10",
      admittedAt: "2026-07-10T12:00:00.000Z",
    })).toMatchObject({ admitted: true, used: 1, remaining: 19 });
    crashed.close();

    const restarted = openDatabase(path);
    databases.push(restarted);
    createStrategyRun(restarted, { id: "restarted-run", stage: "collect" });
    fillAdmissions(restarted, {
      runId: "restarted-run",
      stage: "collect",
      first: 2,
      last: 2_000,
    });

    expect(admitRequest(restarted, {
      runId: "restarted-run",
      retailerId: "retailer-1",
      collectionDay: "2026-07-10",
      stage: "collect",
      admittedAt: "2026-07-10T13:00:00.000Z",
    })).toEqual({ admitted: false, used: 2_000, remaining: 0, admissionId: null });
    expect(restarted.prepare(
      "SELECT status, finished_at FROM runs WHERE id = 'crashed-run'",
    ).get()).toEqual({ status: "running", finished_at: null });
    for (let index = 0; index < 19; index += 1) {
      expect(admitReplaySlot(restarted, {
        runId: "restarted-run",
        retailerId: "retailer-1",
        productId: "crash-product",
        collectionDay: "2026-07-10",
        admittedAt: "2026-07-10T13:00:00.000Z",
      }).admitted).toBe(true);
    }
    expect(admitReplaySlot(restarted, {
      runId: "restarted-run",
      retailerId: "retailer-1",
      productId: "crash-product",
      collectionDay: "2026-07-10",
      admittedAt: "2026-07-10T13:00:00.000Z",
    })).toEqual({ admitted: false, used: 20, remaining: 0, admissionId: null });
  });

  it("caps stages independently and makes admission evidence append-only", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);
    seedStrategy(database, "extraction", extractionStrategy);
    createStrategyRun(database, { id: "collect-cap", stage: "collect" });
    createStrategyRun(database, { id: "discover-open", stage: "discover" });
    fillAdmissions(database, { runId: "collect-cap", stage: "collect", last: 2_000 });

    expect(admitRequest(database, {
      runId: "collect-cap",
      retailerId: "retailer-1",
      collectionDay: "2026-07-10",
      stage: "collect",
      admittedAt: "2026-07-10T12:00:00.000Z",
    }).admitted).toBe(false);
    const discoveryAdmission = admitRequest(database, {
      runId: "discover-open",
      retailerId: "retailer-1",
      collectionDay: "2026-07-10",
      stage: "discover",
      admittedAt: "2026-07-10T12:00:00.000Z",
    });
    expect(discoveryAdmission).toMatchObject({ admitted: true, used: 1, remaining: 1_999 });
    expect(() => database.prepare(
      "UPDATE request_admissions SET admitted_at = admitted_at WHERE id = ?",
    ).run(discoveryAdmission.admissionId)).toThrow(/immutable/iu);
    expect(() => database.prepare(
      "DELETE FROM request_admissions WHERE id = ?",
    ).run(discoveryAdmission.admissionId)).toThrow(/append-only/iu);
  });

  it("rejects request, discovery-reference, and replay admissions for terminal runs", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    seedStrategy(database, "discovery", discoveryStrategy);
    seedStrategy(database, "extraction", extractionStrategy);
    createStrategyRun(database, { id: "terminal-discovery", stage: "discover" });
    createStrategyRun(database, { id: "terminal-collection", stage: "collect" });
    database.prepare(`
      INSERT INTO products
        (id, retailer_id, canonical_url, title, first_seen, last_seen)
      VALUES ('terminal-product', 'retailer-1', 'https://shop.test/terminal-product',
              'Terminal product', '2026-07-10T00:00:00.000Z',
              '2026-07-10T00:00:00.000Z')
    `).run();
    database.prepare(`
      UPDATE runs
      SET status = 'completed', finished_at = '2026-07-10T13:00:00.000Z'
    `).run();

    expect(() => admitRequest(database, {
      runId: "terminal-collection",
      retailerId: "retailer-1",
      collectionDay: "2026-07-10",
      stage: "collect",
      admittedAt: "2026-07-10T14:00:00.000Z",
    })).toThrow(/existing run/iu);
    expect(() => admitDiscoveryReference(database, {
      runId: "terminal-discovery",
      retailerId: "retailer-1",
      collectionDay: "2026-07-10",
      canonicalUrl: "https://shop.test/late",
      admittedAt: "2026-07-10T14:00:00.000Z",
    })).toThrow(/existing run/iu);
    expect(() => admitReplaySlot(database, {
      runId: "terminal-collection",
      retailerId: "retailer-1",
      productId: "terminal-product",
      collectionDay: "2026-07-10",
      admittedAt: "2026-07-10T14:00:00.000Z",
    })).toThrow(/existing run/iu);
    expect(database.prepare("SELECT COUNT(*) AS count FROM request_admissions").get())
      .toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM discovery_reference_admissions",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM replay_slot_admissions").get())
      .toEqual({ count: 0 });
  });
});
