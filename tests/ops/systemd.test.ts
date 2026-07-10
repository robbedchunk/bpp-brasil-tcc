import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

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
  it("renders all four user timers with absolute runtime paths and São Paulo calendars", async () => {
    const home = await temporaryDirectory("precos-systemd-home-");
    const destination = join(home, "units");
    const result = await run("bash", ["ops/install-systemd.sh", "--dry-run"], {
      ...process.env,
      SYSTEMD_UNIT_DIR: destination,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const name of ["daily", "weekly-discovery", "heartbeat", "backup"]) {
      expect(result.stdout).toContain(`precos-${name}.timer`);
      const timer = await readFile(join(destination, `precos-${name}.timer`), "utf8");
      expect(timer).toContain("Persistent=true");
      expect(timer).toContain("RandomizedDelaySec=");
      expect(timer).toContain("America/Sao_Paulo");
    }

    const service = await readFile(join(destination, "precos-daily.service"), "utf8");
    expect(service).toContain(`WorkingDirectory=${projectRoot}`);
    expect(service).toContain(`ExecStart=${process.execPath} ${projectRoot}/dist/cli.js daily --json`);
    expect(service).toContain("Environment=TZ=America/Sao_Paulo");
    const expectedEnv = projectRoot.startsWith(`${process.env.HOME}/`)
      ? `%h/${relative(process.env.HOME ?? "", projectRoot)}/.env`
      : `${projectRoot}/.env`;
    expect(service).toContain(`EnvironmentFile=-${expectedEnv}`);
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

  it("backs up and integrity-checks a disposable database", async () => {
    const result = await run("bash", ["ops/backup.sh", "--self-test"]);

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "backup: self-test ok\n" });
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
});
