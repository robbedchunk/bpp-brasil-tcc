import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

interface CommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

const temporaryDirectories: string[] = [];
const projectRoot = resolve(".");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function run(
  command: string,
  arguments_: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
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
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveResult({ exitCode, stderr, stdout });
    });
  });
}

describe("operations setup", () => {
  it("does not publish or mark a migrated database whose backup fails integrity", async () => {
    const directory = await temporaryDirectory("precos-corrupt-migration-");
    const source = join(directory, "var", "precos.sqlite");
    const destination = join(directory, "data", "precos.sqlite");
    const fakeBin = join(directory, "bin");
    await mkdir(dirname(source), { recursive: true });
    await mkdir(fakeBin);
    expect((await run("sqlite3", [
      source,
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('preserve-me');",
    ])).exitCode).toBe(0);

    const sqliteWrapper = join(fakeBin, "sqlite3");
    await writeFile(sqliteWrapper, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${2:-}" == .backup\\ * ]]; then
  command="\$2"
  target="\${command#.backup \\'}"
  target="\${target%\\'}"
  cp -- "\$1" "\$target"
  printf 'corrupt-page' | dd of="\$target" bs=1 seek=100 conv=notrunc status=none
  exit 0
fi
exec "\${REAL_SQLITE3:?}" "\$@"
`);
    await chmod(sqliteWrapper, 0o755);

    const result = await run("bash", [
      "-c",
      'set -euo pipefail; source "$1"; migrate_legacy_database "$2" "$3"',
      "bash",
      "ops/lib.sh",
      source,
      destination,
    ], {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      REAL_SQLITE3: "/usr/bin/sqlite3",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/integrity/i);
    expect(await readdir(dirname(destination))).toEqual([]);
  });

  it("keeps a populated legacy migration unchanged when setup repeats", async () => {
    const directory = await temporaryDirectory("precos-repeat-migration-");
    const source = join(directory, "var", "precos.sqlite");
    const destination = join(directory, "data", "precos.sqlite");
    await mkdir(dirname(source), { recursive: true });
    expect((await run("sqlite3", [
      source,
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('preserve-me');",
    ])).exitCode).toBe(0);
    const migrate = () => run("bash", [
      "-c",
      'set -euo pipefail; source "$1"; migrate_legacy_database "$2" "$3"',
      "bash",
      "ops/lib.sh",
      source,
      destination,
    ]);

    expect(await migrate()).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    const firstIdentity = `${(await stat(destination)).dev}:${(await stat(destination)).ino}`;
    const firstMarker = await readFile(`${destination}.legacy-migration`, "utf8");

    expect(await migrate()).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    const secondMetadata = await stat(destination);
    expect(`${secondMetadata.dev}:${secondMetadata.ino}`).toBe(firstIdentity);
    expect(await readFile(`${destination}.legacy-migration`, "utf8")).toBe(firstMarker);
    expect((await run("sqlite3", [destination, "SELECT value FROM evidence;"])).stdout)
      .toBe("preserve-me\n");
  });

  it("renders a harmless status-only user timer with absolute runtime paths", async () => {
    const destination = await temporaryDirectory("precos-units-");
    const result = await run("bash", ["ops/install-status-timer.sh"], {
      ...process.env,
      SYSTEMD_DRY_RUN: "1",
      SYSTEMD_UNIT_DIR: destination,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    const service = await readFile(join(destination, "precos-status.service"), "utf8");
    const timer = await readFile(join(destination, "precos-status.timer"), "utf8");
    const npmPath = join(dirname(process.execPath), "npm");

    expect(service).toContain(`WorkingDirectory="${projectRoot}"`);
    expect(service).toContain(
      `Environment="PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin"`,
    );
    expect(service).toContain(
      `ExecStart="${process.execPath}" "${npmPath}" run --silent cli -- status --json`,
    );
    expect(service).not.toMatch(/\b(?:collect|discover|heal|classify|index)\b/);
    expect(timer).toContain("Unit=precos-status.service");
    expect(timer).toContain("OnCalendar=hourly");
  });

  it("enables only the rendered status timer outside dry-run mode", async () => {
    const directory = await temporaryDirectory("precos-systemctl-");
    const destination = join(directory, "units");
    const fakeBin = join(directory, "bin");
    const logPath = join(directory, "systemctl.log");
    await mkdir(fakeBin);
    const systemctlPath = join(fakeBin, "systemctl");
    await writeFile(
      systemctlPath,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"\n',
    );
    await chmod(systemctlPath, 0o755);

    const result = await run("bash", ["ops/install-status-timer.sh"], {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SYSTEMCTL_LOG: logPath,
      SYSTEMD_DRY_RUN: "0",
      SYSTEMD_UNIT_DIR: destination,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(await readFile(logPath, "utf8")).toBe(
      "--user daemon-reload\n--user enable --now precos-status.timer\n",
    );
  });

  it("discovers any installed NVM Node 24 when the default Node is older", async () => {
    const home = await temporaryDirectory("precos-node-home-");
    const defaultBin = join(home, "default-bin");
    const node24Bin = join(home, ".nvm", "versions", "node", "v24.99.0", "bin");
    await mkdir(defaultBin, { recursive: true });
    await mkdir(node24Bin, { recursive: true });
    const defaultNode = join(defaultBin, "node");
    const node24 = join(node24Bin, "node");
    await writeFile(defaultNode, "#!/usr/bin/env bash\nprintf '22\\n'\n");
    await writeFile(node24, "#!/usr/bin/env bash\nprintf '24\\n'\n");
    await chmod(defaultNode, 0o755);
    await chmod(node24, 0o755);

    const result = await run(
      "bash",
      [
        "-c",
        'source "$1"; select_node_24; command -v node',
        "bash",
        "ops/lib.sh",
      ],
      {
        HOME: home,
        PATH: `${defaultBin}:/usr/bin:/bin`,
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${node24}\n`,
    });
  });

  it("installs the pinned analysis environment only when requirements change", async () => {
    const directory = await temporaryDirectory("precos-analysis-setup-");
    const fakePython = join(directory, "python3");
    const venv = join(directory, "venv");
    const logPath = join(directory, "pip.log");
    await writeFile(fakePython, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf 'Python 3.14.4\n'
  exit 0
fi
if [[ "\${1:-}" == "-c" ]]; then
  printf '3.14\n'
  exit 0
fi
if [[ "\${1:-}" == "-m" && "\${2:-}" == "venv" ]]; then
  mkdir -p "\$3/bin"
  cp -- "\$0" "\$3/bin/python"
  chmod 0755 "\$3/bin/python"
  exit 0
fi
if [[ "\${1:-}" == "-m" && "\${2:-}" == "pip" ]]; then
  printf '%s\n' "\$*" >> "\${ANALYSIS_SETUP_LOG:?}"
  exit 0
fi
exit 1
`);
    await chmod(fakePython, 0o755);
    const env = {
      ...process.env,
      ANALYSIS_PYTHON: fakePython,
      ANALYSIS_VENV: venv,
      ANALYSIS_TEST_ROOT: directory,
      ANALYSIS_SETUP_LOG: logPath,
    };

    expect(await run("bash", ["ops/setup-analysis.sh"], env))
      .toEqual({ exitCode: 0, stderr: "", stdout: "analysis-setup: ready.\n" });
    expect(await run("bash", ["ops/setup-analysis.sh"], env))
      .toEqual({ exitCode: 0, stderr: "", stdout: "analysis-setup: ready.\n" });
    expect((await readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(1);
    await writeFile(join(venv, "stale-package.txt"), "must disappear");
    await writeFile(
      join(venv, ".environment-version"),
      `requirements_sha256=${"0".repeat(64)}\npython_version=3.14\n`,
    );
    expect(await run("bash", ["ops/setup-analysis.sh"], env))
      .toEqual({ exitCode: 0, stderr: "", stdout: "analysis-setup: ready.\n" });
    expect((await readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(2);
    await expect(readFile(join(venv, "stale-package.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(venv, "old-python-package.txt"), "must disappear too");
    await writeFile(
      fakePython,
      (await readFile(fakePython, "utf8"))
        .replaceAll("3.14", "3.15"),
    );
    expect(await run("bash", ["ops/setup-analysis.sh"], env))
      .toEqual({ exitCode: 0, stderr: "", stdout: "analysis-setup: ready.\n" });
    expect((await readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(3);
    await expect(readFile(join(venv, "old-python-package.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(venv, ".environment-version"), "utf8"))
      .toMatch(/^requirements_sha256=[0-9a-f]{64}\npython_version=3\.15\n$/u);
  });

  it("refuses to delete an arbitrary analysis environment", async () => {
    const directory = await temporaryDirectory("precos-analysis-unsafe-");
    const fakePython = join(directory, "python3");
    const venv = join(directory, "not-authorized", "venv");
    const sentinel = join(venv, "preserve.txt");
    await mkdir(join(venv, "bin"), { recursive: true });
    await writeFile(sentinel, "preserve");
    await writeFile(fakePython, `#!/usr/bin/env bash
if [[ "\${1:-}" == "-c" ]]; then printf '3.14\n'; exit 0; fi
exit 1
`);
    await writeFile(join(venv, "bin", "python"), `#!/usr/bin/env bash
if [[ "\${1:-}" == "-c" ]]; then printf '3.13\n'; exit 0; fi
exit 1
`);
    await chmod(fakePython, 0o755);
    await chmod(join(venv, "bin", "python"), 0o755);

    const result = await run("bash", ["ops/setup-analysis.sh"], {
      ...process.env,
      ANALYSIS_PYTHON: fakePython,
      ANALYSIS_VENV: venv,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/refus|safe|authorized/i);
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
  });
});
