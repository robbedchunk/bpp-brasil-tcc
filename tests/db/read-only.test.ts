import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { EXPECTED_SCHEMA_MIGRATIONS } from "../../src/db/migration-manifest.js";
import {
  inspectSchemaCapability,
  openReadOnlyDatabase,
  readDataVersion,
  withReadOnlySnapshot,
} from "../../src/db/read-only.js";

const directories: string[] = [];
const latestMigration = EXPECTED_SCHEMA_MIGRATIONS.at(-1)!;
const previousMigration = EXPECTED_SCHEMA_MIGRATIONS.at(-2)!;
const futureVersion = latestMigration.version + 1;

afterEach(async () => Promise.all(directories.splice(0).map((directory) =>
  rm(directory, { recursive: true, force: true }))));

async function temporaryDatabasePath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return join(directory, "precos.sqlite");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("read-only database access", () => {
  it("does not create a missing database", async () => {
    const path = await temporaryDatabasePath("precos-readonly-missing-");

    expect(() => openReadOnlyDatabase(path)).toThrow(expect.objectContaining({
      name: "ReadOnlyDatabaseError",
      code: "missing",
    }));
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("queries a compatible database without changing its bytes or allowing writes", async () => {
    const path = await temporaryDatabasePath("precos-readonly-");
    const writable = openDatabase(path);
    writable.prepare(`
      INSERT INTO retailers (id, name, base_url, cep, domains_json)
      VALUES ('dynamic-shop', 'Dynamic Shop', 'https://dynamic.test',
              '01310-100', '["dynamic.test"]')
    `).run();
    writable.close();
    const before = await readFile(path);

    const database = openReadOnlyDatabase(path);
    try {
      expect(database.pragma("query_only", { simple: true })).toBe(1);
      expect(inspectSchemaCapability(database, ["retailers", "runs"])).toMatchObject({
        status: "compatible",
        actionsSafe: true,
        missingTables: [],
      });
      expect(readDataVersion(database)).toBeGreaterThanOrEqual(0);
      expect(withReadOnlySnapshot(database, () => database.prepare(
        "SELECT id, name FROM retailers",
      ).all())).toEqual([{ id: "dynamic-shop", name: "Dynamic Shop" }]);
      expect(() => database.prepare(
        "UPDATE retailers SET name = 'Rewritten' WHERE id = 'dynamic-shop'",
      ).run()).toThrow(/readonly|read-only|query only/iu);
      expect(() => database.exec("PRAGMA journal_mode = DELETE"))
        .toThrow(/readonly|read-only|query only|disk I\/O/iu);
    } finally {
      database.close();
    }

    expect(sha256(await readFile(path))).toBe(sha256(before));
  });

  it("classifies unrecognized, older, newer, and mismatched schemas", async () => {
    const unrecognizedPath = await temporaryDatabasePath("precos-readonly-unrecognized-");
    const unrecognizedWritable = new Database(unrecognizedPath);
    unrecognizedWritable.exec("CREATE TABLE example (id INTEGER PRIMARY KEY)");
    unrecognizedWritable.close();
    const unrecognized = openReadOnlyDatabase(unrecognizedPath);
    expect(inspectSchemaCapability(unrecognized)).toMatchObject({
      status: "unrecognized",
      currentVersion: null,
      actionsSafe: false,
    });
    unrecognized.close();

    const olderPath = await temporaryDatabasePath("precos-readonly-older-");
    const olderWritable = openDatabase(olderPath);
    olderWritable.prepare("DELETE FROM schema_migrations WHERE version = ?")
      .run(latestMigration.version);
    olderWritable.close();
    const older = openReadOnlyDatabase(olderPath);
    expect(inspectSchemaCapability(older)).toMatchObject({
      status: "older",
      currentVersion: previousMigration.version,
      actionsSafe: false,
    });
    older.close();

    const newerPath = await temporaryDatabasePath("precos-readonly-newer-");
    const newerWritable = openDatabase(newerPath);
    newerWritable.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, 'future_fixture', '2026-07-24T00:00:00.000Z')
    `).run(futureVersion);
    newerWritable.close();
    const newer = openReadOnlyDatabase(newerPath);
    expect(inspectSchemaCapability(newer)).toMatchObject({
      status: "newer",
      currentVersion: futureVersion,
      actionsSafe: false,
    });
    newer.close();

    const mismatchedPath = await temporaryDatabasePath("precos-readonly-mismatch-");
    const mismatchedWritable = openDatabase(mismatchedPath);
    mismatchedWritable.prepare(
      "UPDATE schema_migrations SET name = 'wrong_name' WHERE version = ?",
    ).run(latestMigration.version);
    mismatchedWritable.close();
    const mismatched = openReadOnlyDatabase(mismatchedPath);
    expect(inspectSchemaCapability(mismatched)).toMatchObject({
      status: "incompatible",
      currentVersion: latestMigration.version,
      actionsSafe: false,
      mismatchedMigrations: [expect.objectContaining({
        version: latestMigration.version,
        actualName: "wrong_name",
      })],
    });
    mismatched.close();
  });

  it("observes commits from another connection through data_version", async () => {
    const path = await temporaryDatabasePath("precos-readonly-version-");
    const seed = openDatabase(path);
    seed.close();
    const observer = openReadOnlyDatabase(path);
    try {
      const before = readDataVersion(observer);
      const writer = openDatabase(path);
      writer.prepare(`
        INSERT INTO retailers (id, name, base_url, cep, domains_json)
        VALUES ('later-shop', 'Later Shop', 'https://later.test',
                '01310-100', '["later.test"]')
      `).run();
      writer.close();

      expect(readDataVersion(observer)).not.toBe(before);
      expect(observer.prepare("SELECT COUNT(*) AS count FROM retailers").get())
        .toEqual({ count: 1 });
    } finally {
      observer.close();
    }
  });
});
