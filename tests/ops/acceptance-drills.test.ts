import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import {
  runAlertDrill,
  runBackupDrill,
  validatePublicDrillReceipt,
  type AlertDrillTestRunner,
} from "../../src/ops/acceptance-drills.js";

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

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function testAlertRunner(root: string): Promise<{
  runner: AlertDrillTestRunner;
  commands: Array<{ command: string; args: readonly string[] }>;
}> {
  const releasePath = join(root, "fixture-release");
  const cliPath = join(releasePath, "dist", "cli.js");
  await mkdir(join(releasePath, "dist"), { recursive: true });
  await writeFile(cliPath, "fixture frozen cli\n");
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  const invocationId = "b".repeat(32);
  return {
    commands,
    runner: {
      resolveRelease: ({ evaluatedCommit }) => ({
        releasePath,
        releaseId: "a".repeat(32),
        sourceCommit: evaluatedCommit,
        manifestSha256: "c".repeat(64),
        artifactSetSha256: "d".repeat(64),
        cliArtifactSha256: sha256("fixture frozen cli\n"),
        cliPath,
        nodePath: process.execPath,
      }),
      run: async (command, args, options) => {
        commands.push({ command, args: [...args] });
        if (command === "systemd-run") {
          return { exitCode: 137, stdout: "", stderr: "unit failed by signal\n" };
        }
        if (command === "systemctl" && args.includes("show")) {
          return {
            exitCode: 0,
            stdout: `Result=signal\nExecMainCode=2\nExecMainStatus=9\nInvocationID=${invocationId}\n`,
            stderr: "",
          };
        }
        if (command === "journalctl") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              _SYSTEMD_INVOCATION_ID: invocationId,
              MESSAGE: "Main process exited, code=killed, status=9/KILL",
            })}\n`,
            stderr: "",
          };
        }
        if (command === "systemctl" && args.includes("reset-failed")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === process.execPath && args.slice(-2).join(" ") === "db init") {
          const databasePath = options.env.DATABASE_PATH;
          if (databasePath === undefined) throw new Error("missing isolated database path");
          const database = openDatabase(databasePath);
          database.close();
          return { exitCode: 0, stdout: "Database initialized.\n", stderr: "" };
        }
        if (command === process.execPath
          && args.slice(-3).join(" ") === "heartbeat check --json") {
          const projectRoot = options.env.PROJECT_ROOT;
          if (projectRoot === undefined) throw new Error("missing isolated project root");
          const alertPath = join(projectRoot, "var", "log", "alerts.jsonl");
          await mkdir(join(projectRoot, "var", "log"), { recursive: true, mode: 0o700 });
          await writeFile(alertPath, `${JSON.stringify({
            timestamp: "2026-07-10T12:00:00.000Z",
            severity: "error",
            title: "Preço collection heartbeat stale",
            message: "No successful daily collection heartbeat is recorded",
            details: { stale: true, ageMs: null, lastSuccessAt: null },
          })}\n`, { mode: 0o600 });
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ stale: true, ageMs: null, lastSuccessAt: null })}\n`,
            stderr: "",
          };
        }
        throw new Error(`unexpected drill command: ${command} ${args.join(" ")}`);
      },
    },
  };
}

describe("safe acceptance drills", () => {
  it("binds a real-failure/isolated-heartbeat workflow without changing production heartbeats", async () => {
    const fixture = await databaseFixture();
    const { runner, commands } = await testAlertRunner(fixture.root);
    const before = openDatabase(fixture.path).prepare(
      "SELECT id, completed_at FROM heartbeats ORDER BY id",
    ).all();

    const receipt = await runAlertDrill({
      projectRoot: fixture.root,
      databasePath: fixture.path,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      drillId: () => "e".repeat(32),
      testRunner: runner,
    });

    const afterDatabase = openDatabase(fixture.path);
    const after = afterDatabase.prepare("SELECT id, completed_at FROM heartbeats ORDER BY id").all();
    afterDatabase.close();
    expect(after).toEqual(before);
    expect(receipt).toMatchObject({ drill: "alert", status: "pass" });
    expect(receipt.facts).toMatchObject({
      protocolVersion: 2,
      systemdResult: "signal",
      execMainCode: "killed",
      execMainStatus: 9,
      heartbeatStale: true,
      sourceHeartbeatsUnchanged: true,
      isolatedHeartbeatRows: 0,
      isolatedAlertMode: "0600",
    });
    expect(commands.find(({ command }) => command === "systemd-run")?.args).toEqual([
      "--user",
      "--unit=precos-alert-drill-eeeeeeeeeeee.service",
      "--wait",
      "--property=Type=exec",
      "/bin/sh",
      "-c",
      'kill -KILL "$$"',
    ]);
    expect(commands.some(({ args }) => args.includes("heartbeat") && args.includes("check")))
      .toBe(true);
    expect(Object.keys(receipt).sort()).toEqual([
      "drill", "evaluatedCommit", "facts", "implementationSha256",
      "observedAt", "reasonCodes", "schemaVersion", "status",
    ].sort());
    expect(() => validatePublicDrillReceipt({
      ...receipt,
      facts: { ...receipt.facts, journalInvocationMatched: false },
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

  it("rejects the old in-memory simulated-stale receipt", () => {
    expect(() => validatePublicDrillReceipt({
      schemaVersion: 1,
      drill: "alert",
      status: "pass",
      observedAt: "2026-07-10T12:00:00.000Z",
      evaluatedCommit: "a".repeat(40),
      implementationSha256: "b".repeat(64),
      reasonCodes: [],
      facts: {
        channel: "local",
        accepted: true,
        simulatedStale: true,
      },
    }, "alert")).toThrow(/allowlisted|invalid/iu);
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
    expect(receipt.facts.criticalTableCount).toBeLessThan(11);
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
