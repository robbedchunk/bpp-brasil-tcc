import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { runAlertDrill, runBackupDrill, validatePublicDrillReceipt } from "../../src/ops/acceptance-drills.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) =>
  rm(path, { recursive: true, force: true }))));

async function databaseFixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "acceptance-drill-"));
  directories.push(root);
  const path = join(root, "data", "precos.sqlite");
  const database = openDatabase(path);
  database.prepare(`
    INSERT INTO heartbeats(id, pipeline, scheduled_for, completed_at, status, details_json)
    VALUES ('heartbeat-live', 'collect', '2026-07-10T06:00:00.000Z',
      '2026-07-10T06:10:00.000Z', 'completed', '{"runIds":[]}')
  `).run();
  database.close();
  return { root, path };
}

describe("safe acceptance drills", () => {
  it("sends a local alert drill without inserting or updating a heartbeat", async () => {
    const fixture = await databaseFixture();
    const fallbackPath = join(fixture.root, "var", "log", "alerts.jsonl");
    const before = openDatabase(fixture.path).prepare(
      "SELECT id, completed_at FROM heartbeats ORDER BY id",
    ).all();
    const drillId = randomUUID();

    const receipt = await runAlertDrill({
      projectRoot: fixture.root,
      databasePath: fixture.path,
      fallbackPath,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      drillId: () => drillId,
    });

    const afterDatabase = openDatabase(fixture.path);
    const after = afterDatabase.prepare("SELECT id, completed_at FROM heartbeats ORDER BY id").all();
    afterDatabase.close();
    expect(after).toEqual(before);
    expect(receipt).toMatchObject({ drill: "alert", status: "pass" });
    expect(receipt.facts).toMatchObject({ channel: "local", heartbeatRowsUnchanged: true });
    const line = await readFile(fallbackPath, "utf8");
    expect(line).toContain(drillId);
    expect((await stat(fallbackPath)).mode & 0o777).toBe(0o600);
    expect(Object.keys(receipt).sort()).toEqual([
      "drill", "evaluatedCommit", "facts", "implementationSha256",
      "observedAt", "reasonCodes", "schemaVersion", "status",
    ].sort());
    expect(() => validatePublicDrillReceipt({
      ...receipt,
      facts: { ...receipt.facts, heartbeatRowsUnchanged: false },
    }, "alert")).toThrow(/contradict/i);
  });

  it("uses an online backup and restore-read copy without replacing the source", async () => {
    const fixture = await databaseFixture();
    const before = await readFile(fixture.path);
    const receipt = await runBackupDrill({
      projectRoot: fixture.root,
      databasePath: fixture.path,
      backupDirectory: join(fixture.root, "var", "backups"),
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    expect(receipt).toMatchObject({ drill: "backup", status: "pass" });
    expect(receipt.facts).toMatchObject({ integrityCheck: "ok", foreignKeyViolations: 0, fileMode: "0600" });
    expect(receipt.facts).toMatchObject({
      sourceFingerprintMatchesBackup: true,
      sourceUnchangedAfterBackup: true,
      retentionSelfTestPassed: true,
    });
    expect(await readFile(fixture.path)).toEqual(before);
    expect(receipt.facts.backupArtifactIdSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("var/backups");
    expect(JSON.stringify(receipt)).not.toContain("precos-drill-");
    expect(() => validatePublicDrillReceipt({
      ...receipt,
      facts: { ...receipt.facts, sourceFingerprintMatchesBackup: false },
    }, "backup")).toThrow(/contradict/i);
  });

  it("records a validated local fallback when ntfy rejects the drill", async () => {
    const fixture = await databaseFixture();
    const fallbackPath = join(fixture.root, "var", "log", "alerts.jsonl");
    const receipt = await runAlertDrill({
      projectRoot: fixture.root,
      databasePath: fixture.path,
      fallbackPath,
      ntfyTopic: "acceptance-test-topic",
      fetch: async () => new Response("unavailable", { status: 503 }),
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    expect(receipt).toMatchObject({ drill: "alert", status: "pass" });
    expect(receipt.facts).toMatchObject({
      channel: "local-after-ntfy-failure",
      httpStatus: 503,
      fallbackFileMode: "0600",
    });
    expect(() => validatePublicDrillReceipt(receipt, "alert")).not.toThrow();
  });

  it("cannot pass backup evidence when any critical evidence table is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-drill-incomplete-"));
    directories.push(root);
    const path = join(root, "incomplete.sqlite");
    const database = openDatabase(path);
    database.exec("DROP TABLE cost_ledger;");
    database.close();
    const receipt = await runBackupDrill({
      projectRoot: root,
      databasePath: path,
      backupDirectory: join(root, "var", "backups"),
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    expect(receipt.status).toBe("fail");
    expect(receipt.facts.criticalTableCount).toBeLessThan(10);
  });

  it("fails closed when the database resolves outside the project root", async () => {
    const fixture = await databaseFixture();
    const other = await mkdtemp(join(tmpdir(), "outside-drill-"));
    directories.push(other);
    await expect(runBackupDrill({
      projectRoot: other,
      databasePath: fixture.path,
      backupDirectory: join(other, "backups"),
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    })).rejects.toThrow(/outside/i);
  });
});
