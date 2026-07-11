import { spawn } from "node:child_process";
import {
  cp,
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

const temporaryDirectories: string[] = [];
const projectRoot = resolve(".");

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) =>
  rm(path, { recursive: true, force: true }))));

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
    expect((await readdir(destination)).filter((path) => path.endsWith(".timer")))
      .toHaveLength(6);

    const service = await readFile(join(destination, "precos-daily.service"), "utf8");
    expect(service).toContain(`WorkingDirectory=${projectRoot}`);
    expect(service).toContain(`ExecStart="${process.execPath}" "${projectRoot}/dist/cli.js" daily --json`);
    expect(service).toContain("Environment=TZ=America/Sao_Paulo");
    expect(service).toContain(`EnvironmentFile=-${projectRoot}/.env`);
    expect(service).toContain("OnSuccess=precos-classification.service");
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
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(join(home, ".config", "systemd", "user", "precos-daily.timer")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

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
