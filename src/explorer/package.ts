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
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import type { Strategy } from "../strategies/schema.js";
import type { StrategyPurpose } from "./provider.js";

export interface SandboxSample {
  canonicalUrl: string;
  body?: string;
  capture?: "current" | "archive";
  collectionDay?: string;
}

export interface SandboxFailureSample {
  canonicalUrl?: string | null;
  category: string;
  message?: string | null;
}

export interface SandboxFailureAttempt {
  outcome: string;
  errorMessage?: string | null;
  candidate?: unknown;
}

export interface SandboxPackageInput {
  retailerId: string;
  purpose: StrategyPurpose;
  allowedDomains: readonly string[];
  samples: readonly SandboxSample[];
  oldStrategy?: Strategy | Record<string, unknown>;
  failureSamples?: readonly SandboxFailureSample[];
  failureSampleTotal?: number;
  failureAttempts?: readonly SandboxFailureAttempt[];
  temporaryRoot?: string;
}

export function representativeFailureSamples(
  values: readonly SandboxFailureSample[],
  limit = 60,
): SandboxFailureSample[] {
  const unique = new Map<string, SandboxFailureSample>();
  for (const value of values) {
    const key = JSON.stringify([
      value.category,
      value.canonicalUrl ?? null,
      value.message ?? null,
    ]);
    if (!unique.has(key)) unique.set(key, value);
  }
  const buckets = new Map<string, SandboxFailureSample[]>();
  for (const value of unique.values()) {
    const bucket = buckets.get(value.category) ?? [];
    bucket.push(value);
    buckets.set(value.category, bucket);
  }
  const result: SandboxFailureSample[] = [];
  while (result.length < limit && [...buckets.values()].some((bucket) => bucket.length > 0)) {
    for (const bucket of buckets.values()) {
      const next = bucket.shift();
      if (next !== undefined) result.push(next);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export interface SandboxPackage {
  workspacePath: string;
  files: string[];
  dispose(): Promise<void>;
}

const BEARER_PATTERN = /\b(?:authorization\s*:\s*)?bearer\s+[^\s<>'"]+/giu;
const SECRET_LABEL_PATTERN =
  String.raw`[\p{L}\p{N}_-]*(?:api[_-]?key|authorization|cookie|credential|password|secret|session[_-]?(?:id|token)|token)[\p{L}\p{N}_-]*`;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `(["']?${SECRET_LABEL_PATTERN}["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;<>}\\]]+)`,
  "giu",
);
const SENSITIVE_HTML_ELEMENT =
  /<(?:meta|input)\b(?=[^>]*(?:api[_-]?key|authorization|cookie|credential|password|secret|session[_-]?(?:id|token)|token))[^>]*>/giu;
const SENSITIVE_HTML_ATTRIBUTE = new RegExp(
  `(\\b(?:data-)?${SECRET_LABEL_PATTERN}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
  "giu",
);
const UNIX_HOME_PATTERN = /\/(?:home|Users)\/[^\s"'<>]+/gu;
const WINDOWS_HOME_PATTERN = /[A-Za-z]:\\Users\\[^\s"'<>]+/gu;
const SENSITIVE_JSON_KEY = /(?:^|[_-])(?:auth(?:orization|entication)?|cookie|credential|password|secret|token|api[_-]?key)(?:$|[_-])/iu;

export function redactSandboxText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "[REDACTED]")
    .replace(SENSITIVE_HTML_ELEMENT, "<redacted-sensitive-element>")
    .replace(SENSITIVE_HTML_ATTRIBUTE, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
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
    const validatorPath = join(workspacePath, "validate-strategy");
    await build({
      entryPoints: [fileURLToPath(asset("validate-entry.ts"))],
      outfile: validatorPath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: { js: "#!/usr/bin/env node" },
      legalComments: "none",
      logLevel: "silent",
      sourcemap: false,
    });
    await chmod(validatorPath, 0o700);

    const allowed = new Set(input.allowedDomains.map((domain) => domain.toLowerCase()));
    const samples = input.samples.map((sample) => {
      const url = new URL(sample.canonicalUrl);
      if (url.username || url.password || !allowed.has(url.hostname.toLowerCase())) {
        throw new Error("Sandbox sample URL is outside the retailer domain allowlist");
      }
      if (
        sample.capture !== undefined
        && (
          (sample.capture !== "current" && sample.capture !== "archive")
          || sample.collectionDay === undefined
          || !/^\d{4}-\d{2}-\d{2}$/u.test(sample.collectionDay)
        )
      ) {
        throw new Error("Replay sandbox samples require a valid capture and collection day");
      }
      return {
        canonicalUrl: url.toString(),
        ...(sample.body === undefined ? {} : { body: redactSandboxText(sample.body) }),
        ...(sample.capture === undefined ? {} : { capture: sample.capture }),
        ...(sample.collectionDay === undefined
          ? {}
          : { collectionDay: sample.collectionDay }),
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
    const failures = representativeFailureSamples(input.failureSamples ?? []);
    const priorAttempts = (input.failureAttempts ?? []).slice(-3);
    if (failures.length > 0 || priorAttempts.length > 0) {
      await writeFile(
        join(workspacePath, "failures.json"),
        sanitizedJson({
          total: Math.max(input.failureSampleTotal ?? input.failureSamples?.length ?? 0, failures.length),
          included: failures.length,
          samples: failures,
          priorAttempts,
        }),
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
