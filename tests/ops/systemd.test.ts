import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createScheduledBackupBundle,
  scheduledBackupPairMatchesService,
  validateScheduledBackupPair,
} from "../../src/ops/scheduled-backup.js";

const temporaryDirectories: string[] = [];
const projectRoot = resolve(".");
const sourceTreeClean = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: projectRoot, encoding: "utf8" },
).trim() === "";

async function removeReadOnlyTree(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (entry === null) return;
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    await chmod(path, 0o700);
    await Promise.all((await readdir(path)).map((name) => removeReadOnlyTree(join(path, name))));
  } else if (!entry.isSymbolicLink()) await chmod(path, 0o600);
}

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(async (path) => {
  await removeReadOnlyTree(path);
  await rm(path, { recursive: true, force: true });
})));

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function run(
  command: string,
  arguments_: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

describe("production schedules", () => {
  it("renders all six user timers with absolute runtime paths and São Paulo calendars", async () => {
    const home = await temporaryDirectory("precos-systemd-home-");
    const destination = join(home, "units");
    const result = await run("bash", ["ops/install-systemd.sh", "--dry-run"], {
      ...process.env,
      SYSTEMD_UNIT_DIR: destination,
      SYSTEMD_INSTALL_RECEIPT: join(home, "missing-install-receipt.json"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const name of ["daily", "healing", "weekly-index", "weekly-discovery", "heartbeat", "backup"]) {
      expect(result.stdout).toContain(`precos-${name}.timer`);
      const timer = await readFile(join(destination, `precos-${name}.timer`), "utf8");
      expect(timer).toContain("Persistent=true");
      expect(timer).toContain("RandomizedDelaySec=");
      expect(timer).toContain("America/Sao_Paulo");
    }
    expect(result.stdout).toContain("precos-classification.service");
    expect(result.stdout).not.toContain("precos-classification.timer");
    const renderedNames = await readdir(destination);
    expect(renderedNames.filter((path) => path.endsWith(".timer")))
      .toHaveLength(6);
    for (const name of renderedNames.filter((path) => path.endsWith(".service"))) {
      const rendered = await readFile(join(destination, name), "utf8");
      expect(rendered).toContain(`WorkingDirectory=${projectRoot}`);
      expect(rendered).toContain("Environment=\"PRECOS_RELEASE_ID=00000000000000000000000000000000\"");
      expect(rendered).toContain(
        `ExecStartPre="${process.execPath}" "${projectRoot}/dist/ops/release-manifest.js" verify "${projectRoot}" "${projectRoot}/ops/validation-attestation-public.pem"`,
      );
      expect(rendered).not.toMatch(/@[A-Z][A-Z_]+@/u);
    }

    const service = await readFile(join(destination, "precos-daily.service"), "utf8");
    expect(service).toContain(`WorkingDirectory=${projectRoot}`);
    expect(service).toContain(`ExecStart="${process.execPath}" "${projectRoot}/dist/cli.js" daily --json`);
    expect(service).toContain(`ExecStartPre="${process.execPath}" "${projectRoot}/dist/ops/release-manifest.js" verify "${projectRoot}" "${projectRoot}/ops/validation-attestation-public.pem"`);
    expect(service).toContain("Environment=\"PRECOS_RELEASE_ID=00000000000000000000000000000000\"");
    expect(service).toContain("Environment=TZ=America/Sao_Paulo");
    expect(service).toContain("Environment=PRECOS_SCHEDULE_SOURCE=systemd-timer");
    expect(service).toContain(`EnvironmentFile=-${projectRoot}/.env`);
    expect(service).toContain("OnSuccess=precos-classification.service");
    expect(service).toContain("RefuseManualStart=yes");
    const backupService = await readFile(join(destination, "precos-backup.service"), "utf8");
    expect(backupService).toContain("RefuseManualStart=yes");
    const classificationService = await readFile(
      join(destination, "precos-classification.service"),
      "utf8",
    );
    expect(classificationService).toContain("After=precos-daily.service");
    expect(classificationService).toContain(`WorkingDirectory=${projectRoot}`);
    expect(classificationService).toContain(
      `ExecStart="${process.execPath}" "${projectRoot}/dist/cli.js" classify --batch-size 50 --version 1 --json`,
    );
    expect(classificationService).toContain("Environment=TZ=America/Sao_Paulo");
    expect(classificationService).toContain(`EnvironmentFile=-${projectRoot}/.env`);
    expect(classificationService).toContain("UMask=0077");
    const healingService = await readFile(join(destination, "precos-healing.service"), "utf8");
    expect(healingService).toContain(
      `ExecStart="${process.execPath}" "${projectRoot}/dist/cli.js" heal --pending --json`,
    );
    expect(healingService).toContain("After=network-online.target precos-daily.service");
    expect(healingService).toContain("RestartForceExitStatus=TEMPFAIL");
    expect(healingService).toContain("RestartSec=5m");
    expect(healingService).toContain("StartLimitIntervalSec=0");
    const healingTimer = await readFile(join(destination, "precos-healing.timer"), "utf8");
    expect(healingTimer).toContain("After=precos-daily.timer");
    expect(healingTimer).toContain("OnCalendar=*-*-* 03:30:00 America/Sao_Paulo");
    const weeklyIndexService = await readFile(
      join(destination, "precos-weekly-index.service"),
      "utf8",
    );
    expect(weeklyIndexService).toContain('ExecStart="/usr/bin/bash"');
    expect(weeklyIndexService).toContain(`"${join(projectRoot, "ops", "run-weekly-index.sh")}"`);
    expect(weeklyIndexService).toContain(
      "After=network-online.target precos-daily.service precos-weekly-discovery.service",
    );
    expect(weeklyIndexService).toContain("UMask=0077");
    const weeklyDiscoveryService = await readFile(
      join(destination, "precos-weekly-discovery.service"),
      "utf8",
    );
    expect(weeklyDiscoveryService).toContain(
      `ExecStart="${process.execPath}" "${projectRoot}/dist/cli.js" discover --limit 3000 --json`,
    );
    const weeklyIndexTimer = await readFile(
      join(destination, "precos-weekly-index.timer"),
      "utf8",
    );
    expect(weeklyIndexTimer).toContain("OnCalendar=Mon *-*-* 08:00:00 America/Sao_Paulo");
    expect(weeklyIndexTimer).toContain("RandomizedDelaySec=30m");
  });

  it("does not write the default user unit directory during a dry run", async () => {
    const home = await temporaryDirectory("precos-dry-systemd-home-");
    const result = await run("bash", ["ops/install-systemd.sh", "--dry-run"], {
      ...process.env,
      HOME: home,
      SYSTEMD_INSTALL_RECEIPT: join(home, "missing-install-receipt.json"),
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(join(home, ".config", "systemd", "user", "precos-daily.timer")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(!sourceTreeClean)("preserves schedule activation while binding each deployment to a new frozen release", async () => {
    const home = await temporaryDirectory("precos-systemd-refresh-");
    const destination = join(home, "units");
    const receiptPath = join(home, "operations", "systemd-install.json");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    for (const name of ["systemctl", "sudo"]) {
      const path = join(bin, name);
      await writeFile(path, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    }
    await writeFile(join(bin, "loginctl"), `#!/usr/bin/env bash
if [[ "$1" == "show-user" ]]; then printf 'yes\\n'; fi
`, { mode: 0o755 });
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      SYSTEMD_UNIT_DIR: destination,
      SYSTEMD_INSTALL_RECEIPT: receiptPath,
    };

    const first = await run("bash", ["ops/install-systemd.sh"], env);
    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    const initial = JSON.parse(await readFile(receiptPath, "utf8")) as {
      schemaVersion: number;
      scheduleActivatedAt: string;
      deployedAt: string;
      sourceCommit: string;
      releaseId: string;
      releasePath: string;
      releaseManifestSha256: string;
      unitSetSha256: string;
    };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const second = await run("bash", ["ops/install-systemd.sh"], env);
    expect(second).toMatchObject({ exitCode: 0, stderr: "" });
    const refreshed = JSON.parse(await readFile(receiptPath, "utf8")) as typeof initial;

    expect(initial.schemaVersion).toBe(2);
    expect(refreshed.scheduleActivatedAt).toBe(initial.scheduleActivatedAt);
    expect(Date.parse(refreshed.deployedAt)).toBeGreaterThan(Date.parse(initial.deployedAt));
    expect(refreshed.releaseId).not.toBe(initial.releaseId);
    expect(refreshed.releasePath).not.toBe(initial.releasePath);
    expect(refreshed.sourceCommit).toBe(initial.sourceCommit);
    expect(refreshed.releaseManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(refreshed.unitSetSha256).not.toBe(initial.unitSetSha256);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);

    const installedDaily = await readFile(join(destination, "precos-daily.service"), "utf8");
    const dryRun = await run("bash", ["ops/install-systemd.sh", "--dry-run"], env);
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" });
    expect(dryRun.stdout).toContain(`release ${refreshed.releaseId} ${refreshed.releasePath}`);
    expect(await readFile(join(destination, "precos-daily.service"), "utf8"))
      .toBe(installedDaily);
  }, 30_000);

  it("quotes paths containing systemd syntax characters", async () => {
    const directory = await temporaryDirectory("precos-systemd-special-");
    const copiedRoot = join(directory, 'project % $ "quoted" \\ path');
    const destination = join(directory, "rendered units");
    const home = join(directory, 'home % $ "quoted" \\ path');
    await mkdir(copiedRoot, { recursive: true });
    await mkdir(home, { recursive: true });
    await cp(join(projectRoot, "ops"), join(copiedRoot, "ops"), { recursive: true });

    const result = await run("bash", [join(copiedRoot, "ops", "install-systemd.sh"), "--dry-run"], {
      ...process.env,
      HOME: home,
      SYSTEMD_UNIT_DIR: destination,
    });

    expect(result).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
    const quote = (value: string, escapeDollar = false): string => `"${value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", () => escapeDollar ? "$$" : "$")}"`;
    const systemdPath = (value: string): string => [...value].map((character) => {
      if (/^[A-Za-z0-9/_.:+-]$/u.test(character)) return character;
      if (character === "%") return "%%";
      return [...Buffer.from(character)]
        .map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`)
        .join("");
    }).join("");
    const service = await readFile(join(destination, "precos-daily.service"), "utf8");
    expect(service).toContain(`WorkingDirectory=${systemdPath(copiedRoot)}`);
    expect(service).toContain(
      `ExecStart=${quote(process.execPath, true)} ${quote(join(copiedRoot, "dist", "cli.js"), true)} daily --json`,
    );
    expect(service).toContain(`EnvironmentFile=-${systemdPath(join(copiedRoot, ".env"))}`);
    expect(service).toContain(
      `Environment=${quote(`PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`)}`,
    );

    const units = ["daily", "healing", "weekly-index", "weekly-discovery", "heartbeat", "backup"]
      .flatMap((name) => ["service", "timer"].map((suffix) =>
        join(destination, `precos-${name}.${suffix}`)));
    units.push(join(destination, "precos-classification.service"));
    const verification = await run("systemd-analyze", ["verify", ...units], process.env);
    expect(verification.exitCode, verification.stderr).toBe(0);
  });

  it("backs up and integrity-checks a disposable database", async () => {
    const result = await run("bash", ["ops/backup.sh", "--self-test"]);

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "backup: self-test ok\n" });
  });

  it("atomically binds the exact backup artifact to its systemd invocation receipt", async () => {
    const directory = await temporaryDirectory("precos-backup-receipt-");
    const database = join(directory, "precos.sqlite");
    const backups = join(directory, "backups");
    const artifactPath = join(backups, "precos-20260711T041500-41.sqlite");
    const receiptPath = `${artifactPath}.receipt.json`;
    const invocationId = "0123456789abcdef0123456789abcdef";
    await mkdir(backups, { recursive: true });
    expect((await run("sqlite3", [database, `
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES (14);
      CREATE TABLE runs(id TEXT PRIMARY KEY);
      INSERT INTO runs VALUES ('scheduled-run');
      CREATE TABLE observations(id TEXT);
      CREATE TABLE run_failures(id TEXT);
      CREATE TABLE classifications(id TEXT);
      CREATE TABLE exploration_runs(id TEXT);
      CREATE TABLE exploration_attempts(id TEXT);
      CREATE TABLE healing_events(id TEXT);
      CREATE TABLE retailer_state_events(id TEXT);
      CREATE TABLE heartbeats(id TEXT);
      CREATE TABLE cost_ledger(id TEXT);
    `])).exitCode).toBe(0);

    await createScheduledBackupBundle({
      sourceDatabasePath: database,
      artifactPath,
      receiptPath,
      invocationId,
      cgroupText: "0::/user.slice/user-1001.slice/user@1001.service/app.slice/precos-backup.service\n",
    });

    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      invocationId: string;
      serviceCgroupSha256: string;
      artifactName: string;
      artifactSha256: string;
      completedAt: string;
      semanticTableCounts: Record<string, number>;
      sourceSnapshotFingerprintSha256: string;
      integrityCheck: string;
      quickCheck: string;
      foreignKeyViolations: number;
    };
    expect(receipt).toMatchObject({
      invocationId,
      serviceCgroupSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      integrityCheck: "ok",
      quickCheck: "ok",
      foreignKeyViolations: 0,
      semanticTableCounts: { runs: 1, schema_migrations: 1 },
    });
    expect(receipt.artifactSha256).toBe(createHash("sha256")
      .update(await readFile(artifactPath)).digest("hex"));
    expect(receipt.sourceSnapshotFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(backups)).some((name) => name.includes(".part") || name.includes(".tmp")))
      .toBe(false);
    const validation = validateScheduledBackupPair({
      receiptPath,
      backupDirectory: backups,
      sourceDatabasePath: database,
    });
    expect(validation.valid).toBe(true);
    const completedAt = Date.parse(receipt.completedAt);
    expect(scheduledBackupPairMatchesService(validation, {
      invocationId,
      startedAt: completedAt - 500,
      finishedAt: completedAt + 500,
      currentWindowStart: completedAt - 60_000,
      now: completedAt + 1_000,
    })).toBe(true);
    expect(scheduledBackupPairMatchesService(validation, {
      invocationId: "f".repeat(32),
      startedAt: completedAt - 500,
      finishedAt: completedAt + 500,
      currentWindowStart: completedAt - 60_000,
      now: completedAt + 1_000,
    })).toBe(false);

    await writeFile(artifactPath, "not the receipted database");
    expect(validateScheduledBackupPair({
      receiptPath,
      backupDirectory: backups,
      sourceDatabasePath: database,
    }).valid).toBe(false);
  });

  it("rejects a manually spoofed systemd invocation ID outside the backup service cgroup", async () => {
    const directory = await temporaryDirectory("precos-backup-cgroup-spoof-");
    const database = join(directory, "precos.sqlite");
    const backups = join(directory, "backups");
    await mkdir(backups, { recursive: true });
    expect((await run("sqlite3", [database, "CREATE TABLE evidence(value INTEGER);"])).exitCode)
      .toBe(0);

    const result = await run("bash", ["ops/backup.sh"], {
      ...process.env,
      DATABASE_PATH: database,
      BACKUP_DIRECTORY: backups,
      ATTESTATION_KEY_PATH: join(directory, "absent-private-key.pem"),
      INVOCATION_ID: "0123456789abcdef0123456789abcdef",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/exact precos-backup\.service cgroup/u);
    expect(await readdir(backups)).toEqual([]);
  });

  it("binds the artifact to the pinned source snapshot when the live source changes before receipt", async () => {
    const directory = await temporaryDirectory("precos-backup-source-race-");
    const database = join(directory, "precos.sqlite");
    const backups = join(directory, "backups");
    const artifactPath = join(backups, "precos-20260711T041500-42.sqlite");
    const receiptPath = `${artifactPath}.receipt.json`;
    await mkdir(backups, { recursive: true });
    expect((await run("sqlite3", [database, `
      PRAGMA journal_mode = WAL;
      CREATE TABLE evidence(value INTEGER NOT NULL);
      INSERT INTO evidence VALUES (1);
    `])).exitCode).toBe(0);

    const receipt = await createScheduledBackupBundle({
      sourceDatabasePath: database,
      artifactPath,
      receiptPath,
      invocationId: "0123456789abcdef0123456789abcdef",
      cgroupText: "0::/user.slice/user-1001.slice/user@1001.service/app.slice/precos-backup.service\n",
      afterBackup: async () => {
        const mutation = await run("sqlite3", [database, "INSERT INTO evidence VALUES (2);"]);
        expect(mutation.exitCode, mutation.stderr).toBe(0);
      },
    });

    expect(receipt.semanticTableCounts).toEqual({ evidence: 1 });
    expect((await run("sqlite3", [artifactPath, "SELECT COUNT(*) FROM evidence;"])).stdout).toBe("1\n");
    expect((await run("sqlite3", [database, "SELECT COUNT(*) FROM evidence;"])).stdout).toBe("2\n");
    expect(validateScheduledBackupPair({
      receiptPath,
      backupDirectory: backups,
      sourceDatabasePath: database,
    }).valid).toBe(true);
  });

  it("refuses a copied artifact that diverges from the pinned source snapshot", async () => {
    const directory = await temporaryDirectory("precos-backup-copy-race-");
    const database = join(directory, "precos.sqlite");
    const backups = join(directory, "backups");
    const artifactPath = join(backups, "precos-20260711T041500-43.sqlite");
    await mkdir(backups, { recursive: true });
    expect((await run("sqlite3", [database, `
      CREATE TABLE evidence(value INTEGER NOT NULL);
      INSERT INTO evidence VALUES (1);
    `])).exitCode).toBe(0);

    await expect(createScheduledBackupBundle({
      sourceDatabasePath: database,
      artifactPath,
      receiptPath: `${artifactPath}.receipt.json`,
      invocationId: "0123456789abcdef0123456789abcdef",
      cgroupText: "0::/user.slice/user-1001.slice/user@1001.service/app.slice/precos-backup.service\n",
      afterBackup: async ({ temporaryArtifactPath }) => {
        const mutation = await run("sqlite3", [
          temporaryArtifactPath,
          "INSERT INTO evidence VALUES (2);",
        ]);
        expect(mutation.exitCode, mutation.stderr).toBe(0);
      },
    })).rejects.toThrow(/does not match the coherently captured source snapshot/u);
    expect(await readdir(backups)).toEqual([]);
  });

  it("publishes no artifact or receipt when coherent backup evidence fails", async () => {
    const directory = await temporaryDirectory("precos-backup-invalid-");
    const database = join(directory, "precos.sqlite");
    const backups = join(directory, "backups");
    await mkdir(backups, { recursive: true });
    expect((await run("sqlite3", [database, `
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));
      INSERT INTO child VALUES (99);
    `])).exitCode).toBe(0);

    const result = await run("bash", ["ops/backup.sh"], {
      ...process.env,
      DATABASE_PATH: database,
      BACKUP_DIRECTORY: backups,
      ATTESTATION_KEY_PATH: join(directory, "absent-private-key.pem"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(await readdir(backups)).toEqual([]);
  });

  it("deletes backups immediately after the exact 14-day retention boundary", async () => {
    const directory = await temporaryDirectory("precos-backup-retention-");
    const database = join(directory, "precos.sqlite");
    const backups = join(directory, "backups");
    await mkdir(backups, { recursive: true });
    expect((await run("sqlite3", [database, "CREATE TABLE evidence(value TEXT);"])).exitCode).toBe(0);
    const expired = join(backups, "precos-expired.sqlite");
    const retained = join(backups, "precos-retained.sqlite");
    await writeFile(expired, "expired");
    await writeFile(retained, "retained");
    for (const suffix of ["-wal", "-shm", ".receipt.json"]) {
      await writeFile(`${expired}${suffix}`, `expired${suffix}`);
      await writeFile(`${retained}${suffix}`, `retained${suffix}`);
    }
    const orphanWal = join(backups, "precos-orphan.sqlite-wal");
    const orphanShm = join(backups, "precos-orphan.sqlite-shm");
    const orphanReceipt = join(backups, "precos-orphan.sqlite.receipt.json");
    await writeFile(orphanWal, "orphan wal");
    await writeFile(orphanShm, "orphan shm");
    await writeFile(orphanReceipt, "orphan receipt");
    const now = Date.now();
    const day = 24 * 60 * 60 * 1_000;
    await utimes(expired, new Date(now - 15 * day), new Date(now - 14 * day - 60 * 60 * 1_000));
    await utimes(retained, new Date(now - 13 * day), new Date(now - 14 * day + 60 * 60 * 1_000));

    const result = await run("bash", ["ops/backup.sh"], {
      ...process.env,
      DATABASE_PATH: database,
      BACKUP_DIRECTORY: backups,
    });

    expect(result.exitCode).toBe(0);
    await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    for (const suffix of ["-wal", "-shm", ".receipt.json"]) {
      await expect(stat(`${expired}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(`${retained}${suffix}`, "utf8")).resolves.toBe(`retained${suffix}`);
    }
    for (const orphan of [orphanWal, orphanShm, orphanReceipt]) {
      await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(retained, "utf8")).resolves.toBe("retained");
  });

  it("copies an empty legacy database but refuses to overwrite a populated destination", async () => {
    const directory = await temporaryDirectory("precos-migrate-");
    const source = join(directory, "var", "precos.sqlite");
    const destination = join(directory, "data", "precos.sqlite");
    await mkdir(dirname(source), { recursive: true });
    const initialized = await run("sqlite3", [source, "CREATE TABLE runs(id TEXT); INSERT INTO runs VALUES ('kept');"]);
    expect(initialized.exitCode).toBe(0);
    await mkdir(dirname(destination), { recursive: true });
    await run("sqlite3", [destination, "CREATE TABLE runs(id TEXT); INSERT INTO runs VALUES ('existing');"]);

    const result = await run("bash", [
      "-c",
      'source ops/lib.sh; migrate_legacy_database "$1" "$2"',
      "bash",
      source,
      destination,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/refusing to overwrite/i);
    expect((await run("sqlite3", [source, "SELECT id FROM runs"])).stdout).toBe("kept\n");
    expect((await run("sqlite3", [destination, "SELECT id FROM runs"])).stdout).toBe("existing\n");
  });

  it("copies a schema-only legacy database when the new destination is absent", async () => {
    const directory = await temporaryDirectory("precos-empty-migrate-");
    const source = join(directory, "var", "precos.sqlite");
    const destination = join(directory, "data", "precos.sqlite");
    await mkdir(dirname(source), { recursive: true });
    await run("sqlite3", [source, "CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES (1);"]);

    const result = await run("bash", [
      "-c",
      'source ops/lib.sh; migrate_legacy_database "$1" "$2"',
      "bash",
      source,
      destination,
    ]);

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await run("sqlite3", [destination, "SELECT version FROM schema_migrations"])).stdout)
      .toBe("1\n");
    expect((await run("stat", ["-c", "%a", destination])).stdout).toBe("600\n");
    expect((await run("sqlite3", [source, "SELECT version FROM schema_migrations"])).stdout)
      .toBe("1\n");
  });

  it("repeats a populated legacy migration without overwriting later destination data", async () => {
    const directory = await temporaryDirectory("precos-repeat-migrate-");
    const source = join(directory, "var", "precos.sqlite");
    const destination = join(directory, "data", "precos.sqlite");
    await mkdir(dirname(source), { recursive: true });
    expect((await run("sqlite3", [
      source,
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('legacy');",
    ])).exitCode).toBe(0);
    const migrate = () => run("bash", [
      "-c",
      'source ops/lib.sh; migrate_legacy_database "$1" "$2"',
      "bash",
      source,
      destination,
    ]);

    expect(await migrate()).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await run("sqlite3", [destination, "INSERT INTO evidence VALUES ('new');"])).exitCode)
      .toBe(0);
    expect(await migrate()).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await run("sqlite3", [destination, "SELECT value FROM evidence ORDER BY rowid;"])).stdout)
      .toBe("legacy\nnew\n");
    expect((await run("sqlite3", [source, "SELECT value FROM evidence;"])).stdout)
      .toBe("legacy\n");
  });
});
