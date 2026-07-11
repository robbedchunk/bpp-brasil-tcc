#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import {
  CLASSIFICATION_REVIEW_SIZE,
  buildClassificationReviewTemplate,
  evaluateClassificationReview,
} from "../src/classify/review.js";

interface Arguments {
  command: "export" | "evaluate";
  database?: string;
  output: string;
  version?: number;
  size?: number;
  sampledAt?: string;
  input?: string;
  reviewerId?: string;
  reviewedAt?: string;
}

function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArguments(values: string[]): Arguments {
  const command = values[0];
  if (command !== "export" && command !== "evaluate") {
    throw new Error("usage: classification-review <export|evaluate> [options]");
  }
  const result: Arguments = { command, output: "" };
  const seen = new Set<string>();
  for (let index = 1; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === undefined || ![
      "--database", "--output", "--version", "--size", "--sampled-at",
      "--input", "--reviewer-id", "--reviewed-at",
    ].includes(flag) || seen.has(flag)) {
      throw new Error(`Unknown or duplicate argument: ${flag ?? ""}`);
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    seen.add(flag);
    index += 1;
    if (flag === "--database") result.database = value;
    else if (flag === "--output") result.output = value;
    else if (flag === "--version") result.version = positiveInteger(flag, value);
    else if (flag === "--size") result.size = positiveInteger(flag, value);
    else if (flag === "--sampled-at") result.sampledAt = value;
    else if (flag === "--input") result.input = value;
    else if (flag === "--reviewer-id") result.reviewerId = value;
    else result.reviewedAt = value;
  }
  if (result.output === "") throw new Error("--output is required");
  if (command === "export") {
    if (result.version === undefined) throw new Error("export requires --version");
    if (result.input !== undefined || result.reviewerId !== undefined || result.reviewedAt !== undefined) {
      throw new Error("export does not accept review-evaluation arguments");
    }
  } else if (result.input === undefined || result.reviewerId === undefined) {
    throw new Error("evaluate requires --input and --reviewer-id");
  } else if (result.version !== undefined || result.size !== undefined || result.sampledAt !== undefined) {
    throw new Error("evaluate derives version, size, and sampling time from the reviewed template");
  }
  return result;
}

function inside(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function requiredOutput(root: string, command: Arguments["command"], version: number): string {
  return resolve(root, command === "export"
    ? `data/reviews/classification-review-v${version}.csv`
    : `data/acceptance/evidence/classification-review-v${version}.json`);
}

function writeAtomic(root: string, path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  if (!inside(root, realpathSync(dirname(path)))) {
    throw new Error("Classification review output directory resolves outside the project root");
  }
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o644, flag: "wx" });
  renameSync(temporary, path);
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const projectRoot = realpathSync(resolve(process.env.PROJECT_ROOT ?? "."));
  const requestedDatabasePath = resolve(projectRoot, args.database ?? process.env.DATABASE_PATH ?? "data/precos.sqlite");
  if (!inside(projectRoot, requestedDatabasePath) || !existsSync(requestedDatabasePath)
    || !lstatSync(requestedDatabasePath).isFile()) {
    throw new Error("Classification review database must exist inside the project root");
  }
  const databasePath = realpathSync(requestedDatabasePath);
  if (!inside(projectRoot, databasePath) || !lstatSync(databasePath).isFile()) {
    throw new Error("Classification review database resolves outside the project root");
  }
  const output = resolve(projectRoot, args.output);
  if (!inside(projectRoot, output)) throw new Error("Classification review output must stay inside the project root");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (args.command === "export") {
      const version = args.version!;
      if (output !== requiredOutput(projectRoot, "export", version)) {
        throw new Error(`Export output must be data/reviews/classification-review-v${version}.csv`);
      }
      const template = buildClassificationReviewTemplate(database, {
        version,
        sampledAt: args.sampledAt ?? new Date().toISOString(),
        size: args.size ?? CLASSIFICATION_REVIEW_SIZE,
      });
      writeAtomic(projectRoot, output, template.csv);
      process.stdout.write(`${JSON.stringify({
        status: "exported",
        classificationVersion: template.classificationVersion,
        populationSize: template.populationSize,
        sampleSize: template.sampleSize,
        sampleSha256: template.sampleSha256,
        output: relative(projectRoot, output),
      })}\n`);
      return;
    }
    const input = resolve(projectRoot, args.input!);
    if (!inside(projectRoot, input) || !existsSync(input) || !lstatSync(input).isFile()) {
      throw new Error("Reviewed classification input must exist inside the project root");
    }
    const result = evaluateClassificationReview(database, readFileSync(input), {
      reviewerId: args.reviewerId!,
      reviewedAt: args.reviewedAt ?? new Date().toISOString(),
    });
    if (output !== requiredOutput(projectRoot, "evaluate", result.classificationVersion)) {
      throw new Error(`Evaluation output must be data/acceptance/evidence/classification-review-v${result.classificationVersion}.json`);
    }
    writeAtomic(projectRoot, output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      classificationVersion: result.classificationVersion,
      sampleSize: result.sampleSize,
      precision: result.overall.precision,
      agreementRate: result.overall.agreementRate,
      output: relative(projectRoot, output),
    })}\n`);
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`classification-review: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 1;
}
