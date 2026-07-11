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
  type StrategyValidationEvidence,
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

function boundReceiptSha256(
  database: Database.Database,
  receiptPath: string,
): string | null {
  const row = database.prepare(
    `SELECT receipt_sha256
     FROM strategy_validation_evidence
     WHERE receipt_path = ?`,
  ).get(receiptPath) as { receipt_sha256: string } | undefined;
  return row?.receipt_sha256 ?? null;
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
    const relativePath = canonicalReceiptPath(context);
    const destination = resolve(projectRoot, relativePath);
    const resolvedRelative = relative(projectRoot, destination).split(sep).join("/");
    if (resolvedRelative !== relativePath) {
      throw new Error("Trusted validation receipt escaped its canonical project path");
    }
    const publicKey = readValidationVerificationPublicKey(
      join(projectRoot, "ops/validation-attestation-public.pem"),
    );
    const readCanonical = (): StrategyValidationEvidence =>
      readStrategyValidationEvidence(destination, {
        retailerId: context.retailerId,
        purpose: context.purpose,
        strategyVersion: context.strategyVersion,
        strategy,
        verificationPublicKey: publicKey,
        authoritativeRefs: refs,
      });
    try {
      const recovered = readCanonical();
      if (recovered.activatable !== true) {
        throw new Error("Canonical candidate receipt is not activatable");
      }
      const recoveredSha256 = validationReceiptSha256(recovered);
      const boundSha256 = boundReceiptSha256(options.database, relativePath);
      if (boundSha256 !== null && boundSha256 !== recoveredSha256) {
        throw new Error("Canonical candidate receipt differs from its immutable database binding");
      }
      return {
        attempted: recovered.attempted,
        valid: recovered.valid,
        score: recovered.score,
        activatable: true,
        receipt: {
          path: relativePath,
          sha256: recoveredSha256,
          evidence: recovered,
        },
      };
    } catch (error) {
      const bound = boundReceiptSha256(options.database, relativePath);
      if (bound !== null) {
        throw new Error(
          `Bound validation receipt ${relativePath} cannot be recovered for this candidate`,
          { cause: error },
        );
      }
      await unlink(destination).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
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
      let evidence = readStrategyValidationEvidence(resolve(summary.path), {
        retailerId: context.retailerId,
        purpose: context.purpose,
        strategyVersion: context.strategyVersion,
        strategy,
        verificationPublicKey: publicKey,
        authoritativeRefs: refs,
      });
      if (evidence.activatable) {
        try {
          await publishImmutableReceipt(resolve(summary.path), destination);
        } catch (error) {
          try {
            evidence = readCanonical();
          } catch {
            throw error;
          }
        }
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
              },
            }
          : {}),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
