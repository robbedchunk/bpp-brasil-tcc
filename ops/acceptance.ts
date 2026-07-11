#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { loadConfig } from "../src/config.js";
import {
  acceptanceExitCode,
  buildAcceptanceReport,
  renderAcceptanceMarkdown,
  verifyAcceptanceSnapshot,
  type CommandEvidence,
  type ServiceState,
  type ServiceStateReader,
} from "../src/ops/acceptance.js";

const execFileAsync = promisify(execFile);

interface CliOptions {
  json: boolean;
  requireComplete: boolean;
  writeJson?: string;
  writeMarkdown?: string;
  verifySnapshot?: string;
}

function parseArguments(args: string[]): CliOptions {
  const result: CliOptions = { json: false, requireComplete: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") result.json = true;
    else if (argument === "--require-complete") result.requireComplete = true;
    else if (["--write-json", "--write-markdown", "--verify-snapshot"].includes(argument ?? "")) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === "--write-json") result.writeJson = value;
      else if (argument === "--write-markdown") result.writeMarkdown = value;
      else result.verifySnapshot = value;
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
  }
  if (result.verifySnapshot !== undefined
    && (result.writeJson !== undefined || result.writeMarkdown !== undefined || result.requireComplete)) {
    throw new Error("--verify-snapshot cannot be combined with write or completion flags");
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runCommand(id: string, command: string, args: string[]): Promise<CommandEvidence> {
  const startedAt = new Date().toISOString();
  let exitCode = 0;
  let output = "";
  try {
    const result = await execFileAsync(command, args, {
      cwd: resolve(process.env.PROJECT_ROOT ?? "."),
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    exitCode = typeof failure.code === "number" ? failure.code : 1;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
  const finishedAt = new Date().toISOString();
  return {
    id,
    exitCode,
    startedAt,
    finishedAt,
    outputSha256: sha256(output),
    facts: { completed: true },
  };
}

async function systemctlState(unit: string): Promise<ServiceState> {
  const readValue = async (args: string[]): Promise<string> => {
    try {
      const result = await execFileAsync("systemctl", ["--user", ...args], { encoding: "utf8" });
      return result.stdout.trim();
    } catch (error) {
      return String((error as { stdout?: string }).stdout ?? "").trim();
    }
  };
  const [enabled, active, properties] = await Promise.all([
    readValue(["is-enabled", unit]),
    readValue(["is-active", unit]),
    readValue(["show", unit, "--property=Result,ExecMainStartTimestamp,ExecMainExitTimestamp", "--value"]),
  ]);
  const [result, lastStartedAt, lastFinishedAt] = properties.split("\n");
  return {
    unit,
    enabled: enabled === "enabled",
    active: active === "active",
    result: result === undefined || result === "" ? null : result,
    lastStartedAt: lastStartedAt === undefined || lastStartedAt === "" ? null : lastStartedAt,
    lastFinishedAt: lastFinishedAt === undefined || lastFinishedAt === "" ? null : lastFinishedAt,
  };
}

const serviceReader: ServiceStateReader = {
  async read(units): Promise<ServiceState[]> {
    return Promise.all(units.map(systemctlState));
  },
};

function inside(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function writeAtomic(root: string, path: string, content: string): void {
  const destination = resolve(path);
  if (!inside(root, destination)) throw new Error("Report output path must remain inside the project root");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const temporary = `${destination}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o644 });
  renameSync(temporary, destination);
}

async function main(): Promise<void> {
  let cli: CliOptions;
  try {
    cli = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`acceptance: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    process.exitCode = 2;
    return;
  }
  const projectRoot = resolve(process.env.PROJECT_ROOT ?? ".");
  const envPath = resolve(projectRoot, ".env");
  try {
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    if (cli.verifySnapshot !== undefined) {
      const verification = await verifyAcceptanceSnapshot(projectRoot, resolve(cli.verifySnapshot));
      process.stdout.write(`${JSON.stringify(verification)}\n`);
      process.exitCode = verification.status === "pass" ? 0 : 1;
      return;
    }
    const config = loadConfig({ ...process.env, PROJECT_ROOT: projectRoot });
    const report = await buildAcceptanceReport({
      projectRoot,
      databasePath: config.databasePath,
      now: () => new Date(),
      runCommand,
      serviceReader,
      credentialConfigured: config.openaiApiKey !== undefined,
      spendAuthorized: process.env.LIVE_OPENAI === "1",
      siteValidated: process.env.SITE_VALIDATED === "1",
      authorityApproved: process.env.AUTHORITY_APPROVED === "1",
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderAcceptanceMarkdown(report);
    if (cli.writeJson !== undefined) writeAtomic(projectRoot, cli.writeJson, json);
    if (cli.writeMarkdown !== undefined) writeAtomic(projectRoot, cli.writeMarkdown, markdown);
    process.stdout.write(cli.json ? `${JSON.stringify(report)}\n` : markdown);
    process.exitCode = acceptanceExitCode(report.overallStatus, cli.requireComplete);
  } catch (error) {
    process.stderr.write(`acceptance: ${error instanceof Error ? error.message : "runtime error"}\n`);
    process.exitCode = 2;
  }
}

await main();
