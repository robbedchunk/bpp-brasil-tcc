import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
});
