import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Strategy } from "../strategies/schema.js";
import type { StrategyPurpose } from "./provider.js";

export interface SandboxSample {
  canonicalUrl: string;
  body?: string;
}

export interface SandboxFailureSample {
  canonicalUrl?: string | null;
  category: string;
  message?: string | null;
}

export interface SandboxPackageInput {
  retailerId: string;
  purpose: StrategyPurpose;
  allowedDomains: readonly string[];
  samples: readonly SandboxSample[];
  oldStrategy?: Strategy | Record<string, unknown>;
  failureSamples?: readonly SandboxFailureSample[];
  temporaryRoot?: string;
}

export interface SandboxPackage {
  workspacePath: string;
  files: string[];
  dispose(): Promise<void>;
}

const BEARER_PATTERN = /\b(?:authorization\s*:\s*)?bearer\s+[^\s<>'"]+/giu;
const SECRET_ASSIGNMENT_PATTERN = /\b(?:api[_-]?key|secret|token|password|cookie)\b\s*[:=]\s*[^\s,;<>]+/giu;
const UNIX_HOME_PATTERN = /\/(?:home|Users)\/[^\s"'<>]+/gu;
const WINDOWS_HOME_PATTERN = /[A-Za-z]:\\Users\\[^\s"'<>]+/gu;
const SENSITIVE_JSON_KEY = /(?:^|[_-])(?:auth(?:orization|entication)?|cookie|credential|password|secret|token|api[_-]?key)(?:$|[_-])/iu;

export function redactSandboxText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "[REDACTED]")
    .replace(UNIX_HOME_PATTERN, "[REDACTED]")
    .replace(WINDOWS_HOME_PATTERN, "[REDACTED]");
}

function sanitizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSandboxText(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Sandbox evidence must not contain cycles");
    seen.add(value);
    return value.map((item) => sanitizeJsonValue(item, seen));
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Sandbox evidence must not contain cycles");
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SENSITIVE_JSON_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeJsonValue(child, seen),
  ]));
}

function sanitizedJson(value: unknown): string {
  return JSON.stringify(sanitizeJsonValue(value, new WeakSet()), null, 2);
}

export async function createSandboxPackage(
  input: SandboxPackageInput,
): Promise<SandboxPackage> {
  const root = resolve(input.temporaryRoot ?? tmpdir());
  await mkdir(root, { recursive: true, mode: 0o700 });
  const workspacePath = await mkdtemp(join(root, "strategy-explorer-"));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(workspacePath, { recursive: true, force: true });
  };

  try {
    const asset = (name: string): URL => new URL(`./sandbox/${name}`, import.meta.url);
    await copyFile(asset("AGENTS.md"), join(workspacePath, "AGENTS.md"));
    await copyFile(
      asset("strategy-schema.md"),
      join(workspacePath, "strategy-schema.md"),
    );
    await copyFile(
      asset("validate-strategy"),
      join(workspacePath, "validate-strategy"),
    );
    await chmod(join(workspacePath, "validate-strategy"), 0o700);

    const allowed = new Set(input.allowedDomains.map((domain) => domain.toLowerCase()));
    const samples = input.samples.map((sample) => {
      const url = new URL(sample.canonicalUrl);
      if (url.username || url.password || !allowed.has(url.hostname.toLowerCase())) {
        throw new Error("Sandbox sample URL is outside the retailer domain allowlist");
      }
      return {
        canonicalUrl: url.toString(),
        ...(sample.body === undefined ? {} : { body: redactSandboxText(sample.body) }),
      };
    });
    await writeFile(
      join(workspacePath, "samples.json"),
      sanitizedJson({
        retailerId: redactSandboxText(input.retailerId),
        purpose: input.purpose,
        allowedDomains: [...allowed],
        samples,
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    if (input.oldStrategy !== undefined) {
      await writeFile(
        join(workspacePath, "old-strategy.json"),
        sanitizedJson(input.oldStrategy),
        { encoding: "utf8", mode: 0o600 },
      );
    }
    if (input.failureSamples !== undefined && input.failureSamples.length > 0) {
      await writeFile(
        join(workspacePath, "failures.json"),
        sanitizedJson(input.failureSamples),
        { encoding: "utf8", mode: 0o600 },
      );
    }

    const files = (await readdir(workspacePath)).sort();
    return { workspacePath, files, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
