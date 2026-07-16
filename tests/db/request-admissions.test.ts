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
  isWeeklyDiscoveryDay,
  remainingRequestAdmissions,
  requestAdmissionCapForStage,
  requestAdmissionsForStageOnDay,
} from "../../src/db/repositories.js";
import {
  seedRetailer,
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
  database.prepare(`
    INSERT INTO runs
      (id, retailer_id, stage, collection_day, status, attempted, ok, failed,
       started_at)
    VALUES (?, 'retailer-1', ?, ?, 'running', 0, 0, 0,
            '2026-07-10T12:00:00.000Z')
  `).run(input.id, input.stage, input.day ?? "2026-07-10");
}

function fillAdmissions(
  database: ReturnType<typeof openDatabase>,
  input: {
    runId: string;
    stage: "discover" | "collect";
    first?: number;
    last: number;
    day?: string;
  },
): void {
  const first = input.first ?? 1;
  const day = input.day ?? "2026-07-10";
  database.prepare(`
    WITH RECURSIVE ordinals(ordinal) AS (
      VALUES (?)
      UNION ALL
      SELECT ordinal + 1 FROM ordinals WHERE ordinal < ?
    )
    INSERT INTO request_admissions
      (id, run_id, retailer_id, collection_day, stage, stage_ordinal, admitted_at)
    SELECT
      printf('%s-%04d', ?, ordinal), ?, 'retailer-1', ?, ?, ordinal,
      ? || 'T12:00:00.000Z'
    FROM ordinals
  `).run(
    first,
    input.last,
    `${input.runId}-admission`,
    input.runId,
    day,
    input.stage,
    day,
  );
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

  it("shares one retailer/day cap across stages and keeps evidence append-only", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
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
    expect(discoveryAdmission).toEqual({
      admitted: false,
      used: 2_000,
      remaining: 0,
      admissionId: null,
    });
    expect(() => database.prepare(
      "UPDATE request_admissions SET admitted_at = admitted_at WHERE id = ?",
    ).run("collect-cap-admission-0001")).toThrow(/immutable/iu);
    expect(() => database.prepare(
      "DELETE FROM request_admissions WHERE id = ?",
    ).run("collect-cap-admission-0001")).toThrow(/append-only/iu);
  });

  it("derives the weekly discovery day and stage caps from the collection day", () => {
    expect(isWeeklyDiscoveryDay("2026-07-12")).toBe(true);
    expect(isWeeklyDiscoveryDay("2026-07-13")).toBe(false);
    expect(isWeeklyDiscoveryDay("2026-07-19")).toBe(true);
    expect(() => isWeeklyDiscoveryDay("2026-7-12")).toThrow(RangeError);
    expect(() => isWeeklyDiscoveryDay("2026-02-30")).toThrow(RangeError);
    expect(requestAdmissionCapForStage("2026-07-12", "collect")).toBe(1_800);
    expect(requestAdmissionCapForStage("2026-07-12", "discover")).toBe(2_000);
    expect(requestAdmissionCapForStage("2026-07-13", "collect")).toBe(2_000);
    expect(requestAdmissionCapForStage("2026-07-13", "discover")).toBe(2_000);
  });

  it("caps Sunday collection at 1,800 and never refunds the discovery reservation", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    createStrategyRun(database, {
      id: "sunday-collect",
      stage: "collect",
      day: "2026-07-12",
    });
    fillAdmissions(database, {
      runId: "sunday-collect",
      stage: "collect",
      last: 1_799,
      day: "2026-07-12",
    });

    expect(remainingRequestAdmissions(
      database,
      "retailer-1",
      "2026-07-12",
      "collect",
    )).toBe(1);
    expect(admitRequest(database, {
      runId: "sunday-collect",
      retailerId: "retailer-1",
      collectionDay: "2026-07-12",
      stage: "collect",
      admittedAt: "2026-07-12T06:00:00.000Z",
    })).toMatchObject({ admitted: true, used: 1_800, remaining: 0 });
    // The reservation is not refundable to collection: 200 shared requests
    // remain unspent, yet every further collect admission fails closed.
    expect(admitRequest(database, {
      runId: "sunday-collect",
      retailerId: "retailer-1",
      collectionDay: "2026-07-12",
      stage: "collect",
      admittedAt: "2026-07-12T06:00:01.000Z",
    })).toEqual({ admitted: false, used: 1_800, remaining: 0, admissionId: null });
    expect(remainingRequestAdmissions(
      database,
      "retailer-1",
      "2026-07-12",
      "collect",
    )).toBe(0);
    expect(remainingRequestAdmissions(
      database,
      "retailer-1",
      "2026-07-12",
      "discover",
    )).toBe(200);
  });

  it("lets Sunday discovery spend exactly the shared remainder before failing closed", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    createStrategyRun(database, {
      id: "sunday-collect",
      stage: "collect",
      day: "2026-07-12",
    });
    createStrategyRun(database, {
      id: "sunday-discover",
      stage: "discover",
      day: "2026-07-12",
    });
    fillAdmissions(database, {
      runId: "sunday-collect",
      stage: "collect",
      last: 1_800,
      day: "2026-07-12",
    });

    for (let index = 0; index < 200; index += 1) {
      const admission = admitRequest(database, {
        runId: "sunday-discover",
        retailerId: "retailer-1",
        collectionDay: "2026-07-12",
        stage: "discover",
        admittedAt: "2026-07-12T21:00:00.000Z",
      });
      expect(admission.admitted).toBe(true);
      expect(admission.remaining).toBe(200 - index - 1);
    }
    expect(admitRequest(database, {
      runId: "sunday-discover",
      retailerId: "retailer-1",
      collectionDay: "2026-07-12",
      stage: "discover",
      admittedAt: "2026-07-12T21:30:00.000Z",
    })).toEqual({ admitted: false, used: 2_000, remaining: 0, admissionId: null });
    expect(requestAdmissionsForStageOnDay(
      database,
      "retailer-1",
      "2026-07-12",
      "collect",
    )).toBe(1_800);
    expect(requestAdmissionsForStageOnDay(
      database,
      "retailer-1",
      "2026-07-12",
      "discover",
    )).toBe(200);
  });

  it("keeps the full shared ledger for collection on non-discovery days", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    createStrategyRun(database, {
      id: "monday-collect",
      stage: "collect",
      day: "2026-07-13",
    });
    fillAdmissions(database, {
      runId: "monday-collect",
      stage: "collect",
      last: 1_999,
      day: "2026-07-13",
    });

    expect(admitRequest(database, {
      runId: "monday-collect",
      retailerId: "retailer-1",
      collectionDay: "2026-07-13",
      stage: "collect",
      admittedAt: "2026-07-13T06:00:00.000Z",
    })).toMatchObject({ admitted: true, used: 2_000, remaining: 0 });
    expect(admitRequest(database, {
      runId: "monday-collect",
      retailerId: "retailer-1",
      collectionDay: "2026-07-13",
      stage: "collect",
      admittedAt: "2026-07-13T06:00:01.000Z",
    })).toEqual({ admitted: false, used: 2_000, remaining: 0, admissionId: null });
  });

  it("rejects request, discovery-reference, and replay admissions for terminal runs", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
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
