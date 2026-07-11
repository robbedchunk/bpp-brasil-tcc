import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type Database from "better-sqlite3";

import {
  loadRetailerConfigs,
  type RetailerConfig,
} from "../retailers/config.js";
import type { Strategy } from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import {
  readStrategyValidationEvidence,
  readValidationVerificationPublicKey,
  validationReceiptSha256,
} from "../strategies/validation-evidence.js";
import type {
  CandidateValidationContext,
  CandidateValidationReport,
} from "./explore.js";

const execFileAsync = promisify(execFile);

export interface TrustedCandidateValidatorOptions {
  database: Database.Database;
  projectRoot?: string;
  runnerPath?: string;
  signingPrivateKeyPath?: string;
  verificationPublicKeyPath?: string;
  executeRunner?: (
    executable: string,
    arguments_: readonly string[],
    options: { cwd: string; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

function canonicalReceiptPath(context: CandidateValidationContext): string {
  return `data/validation/${context.retailerId}-${context.purpose}-v${context.strategyVersion}.json`;
}

function validationPlaceholder(
  config: RetailerConfig,
  purpose: "discovery" | "extraction",
  version: number,
) {
  return {
    ...config.validation[purpose],
    externallyValidated: true,
    validatedAt: "2000-01-01T00:00:00.000Z",
    sampleSize: 30,
    successes: 27,
    score: 0.9,
    receiptPath: `data/validation/${config.id}-${purpose}-v${version}.json`,
    receiptSha256: null,
  };
}

function candidateConfig(
  config: RetailerConfig,
  strategy: Strategy,
  context: CandidateValidationContext,
): RetailerConfig {
  const versions = {
    ...config.strategyVersions,
    [context.purpose]: context.strategyVersion,
  };
  return {
    ...config,
    active: true,
    strategyVersions: versions,
    [context.purpose]: strategy,
    validation: {
      discovery: validationPlaceholder(config, "discovery", versions.discovery),
      extraction: validationPlaceholder(config, "extraction", versions.extraction),
    },
  } as RetailerConfig;
}

async function regularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`Trusted validation runner is not a regular file: ${path}`);
}

async function publishImmutableReceipt(source: string, destination: string): Promise<boolean> {
  const content = await readFile(source);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(destination);
      if (!existing.equals(content)) {
        throw new Error(
          `Validation receipt ${destination} already binds different immutable evidence`,
        );
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return created;
}

function databaseFile(database: Database.Database): string {
  const name = database.name;
  if (name === "" || name === ":memory:") {
    throw new Error("Trusted live validation requires a file-backed authoritative database");
  }
  return resolve(name);
}

export function createTrustedCandidateValidator(
  options: TrustedCandidateValidatorOptions,
): (
  strategy: Strategy,
  refs: readonly ProductRef[],
  context: CandidateValidationContext,
) => Promise<CandidateValidationReport> {
  return async (strategy, refs, context) => {
    const projectRoot = resolve(options.projectRoot ?? process.cwd());
    const runner = resolve(
      options.runnerPath ?? join(projectRoot, "dist/scripts/validate-strategies.js"),
    );
    await regularFile(runner);
    const config = loadRetailerConfigs(join(projectRoot, "retailers"))
      .find((candidate) => candidate.id === context.retailerId);
    if (config === undefined) {
      throw new Error(`Retailer config ${context.retailerId} is unavailable for trusted validation`);
    }
    const scratchRoot = join(projectRoot, "var/validation-candidates");
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(join(scratchRoot, `${context.retailerId}-`));
    const configsDirectory = join(scratch, "configs");
    const outputDirectory = join(scratch, "receipts");
    await mkdir(configsDirectory, { recursive: true, mode: 0o700 });
    const configPath = join(configsDirectory, `${context.retailerId}.json`);
    const handle = await open(configPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify(candidateConfig(config, strategy, context), null, 2)}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      const execute = options.executeRunner ?? (async (executable, arguments_, runOptions) => {
        const result = await execFileAsync(executable, [...arguments_], runOptions);
        return { stdout: result.stdout, stderr: result.stderr };
      });
      const result = await execute(process.execPath, [
        runner,
        "--retailer",
        context.retailerId,
        "--purpose",
        context.purpose,
        "--database",
        databaseFile(options.database),
        "--configs",
        configsDirectory,
        "--output-directory",
        outputDirectory,
        "--signing-private-key",
        resolve(
          options.signingPrivateKeyPath
            ?? join(projectRoot, "var/operations/validation-attestation-private.pem"),
        ),
      ], { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 });
      const output = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
      if (output === undefined) {
        throw new Error(`Trusted validation runner returned no receipt summary: ${result.stderr}`);
      }
      const summary = JSON.parse(output) as { path?: unknown };
      if (typeof summary.path !== "string") {
        throw new Error("Trusted validation runner returned an invalid receipt path");
      }
      const publicKey = readValidationVerificationPublicKey(resolve(
        options.verificationPublicKeyPath
          ?? join(projectRoot, "ops/validation-attestation-public.pem"),
      ));
      const evidence = readStrategyValidationEvidence(resolve(summary.path), {
        retailerId: context.retailerId,
        purpose: context.purpose,
        strategyVersion: context.strategyVersion,
        strategy,
        verificationPublicKey: publicKey,
        authoritativeRefs: refs,
      });
      const relativePath = canonicalReceiptPath(context);
      const destination = resolve(projectRoot, relativePath);
      const receiptCreated = evidence.activatable
        ? await publishImmutableReceipt(resolve(summary.path), destination)
        : false;
      const resolvedRelative = relative(projectRoot, destination).split(sep).join("/");
      if (resolvedRelative !== relativePath) {
        throw new Error("Trusted validation receipt escaped its canonical project path");
      }
      return {
        attempted: evidence.attempted,
        valid: evidence.valid,
        score: evidence.score,
        activatable: evidence.activatable,
        ...(evidence.activatable
          ? {
              receipt: {
                path: relativePath,
                sha256: validationReceiptSha256(evidence),
                evidence,
                verificationPublicKey: publicKey,
                ...(receiptCreated
                  ? { cleanup: async () => unlink(destination).catch(() => undefined) }
                  : {}),
              },
            }
          : {}),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
