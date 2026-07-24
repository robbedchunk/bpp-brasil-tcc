#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Command } from "commander";
import { chromium, type Browser } from "playwright";
import { z } from "zod";

import { executeExtraction } from "../src/collection/executor.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_HTTP_TIMEOUT_MS,
  fetchBounded,
  type FetchLike,
} from "../src/collection/http.js";
import { executeDiscovery } from "../src/discovery/executor.js";
import { openDatabase } from "../src/db/database.js";
import { DiscoveryFailureError } from "../src/discovery/failure.js";
import { RobotsPolicy } from "../src/discovery/robots.js";
import { redact } from "../src/ops/logger.js";
import {
  loadRetailerConfigs,
  registerRetailerConfigs,
  type RetailerConfig,
} from "../src/retailers/config.js";
import type {
  DiscoveryStrategy,
  ExtractionStrategy,
} from "../src/strategies/schema.js";
import type {
  ExtractionFailure,
  ExtractionResult,
  ProductRef,
} from "../src/strategies/types.js";
import {
  selectStrategyValidationChallenge,
  VALIDATION_CHALLENGE_ALGORITHM,
} from "../src/strategies/validation-challenge.js";
import { extractionValidationFailureReason } from "../src/strategies/validate.js";
import {
  attestStrategyValidationEvidence,
  canonicalEvidenceJson,
  evidenceValueSha256,
  readValidationSigningPrivateKey,
  readTrustedValidatorArtifactSha256,
  strategyEvidenceSha256,
  validateStrategyEvidence,
  validationAttestationKeyId,
  validationReceiptSha256,
  validationRefSha256,
  validationSampleSetSha256,
  type StrategyValidationEvidence,
} from "../src/strategies/validation-evidence.js";

const SAMPLE_SIZE = 30;
const MINIMUM_PACING_MS = 500;
const DISCOVERY_VALIDATION_TIMEOUT_MS = 3 * 60 * 1_000;
const EXECUTING_ARTIFACT_SHA256 = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
type Purpose = "discovery" | "extraction";
type ValidationSample = StrategyValidationEvidence["samples"][number];
type ResponseEvidence = NonNullable<ValidationSample["response"]>;

interface RecordedExchange {
  request: ValidationSample["request"];
  response: ResponseEvidence | null;
  body: string | null;
  captureError: string | null;
  logicalStartedAt: number;
  mainDocument: boolean;
}

export interface ValidationRunDependencies {
  database: Database.Database;
  outputDirectory: string;
  signingPrivateKey: KeyObject;
  fetch?: FetchLike;
  browser?: Browser;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  pacingMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  runtime?: string;
}

export interface ValidationRunResult {
  path: string;
  evidence: StrategyValidationEvidence;
}

interface ValidatorExecutorIdentity {
  mode: "trusted-live-host" | "test";
  runtime: string;
  sourceCommit: string;
  playwrightVersion: string;
  chromiumVersion: string;
  artifactSha256: string;
}

interface ValidatorExecutorInspection {
  identity: ValidatorExecutorIdentity;
  dirtyPaths: string[];
}

function clockNow(dependencies: ValidationRunDependencies): number {
  return dependencies.clock?.() ?? performance.now();
}

function executorIdentity(
  dependencies: ValidationRunDependencies,
): ValidatorExecutorInspection {
  const injected = dependencies.fetch !== undefined
    || dependencies.browser !== undefined
    || dependencies.now !== undefined
    || dependencies.sleep !== undefined
    || dependencies.clock !== undefined
    || dependencies.runtime !== undefined;
  if (injected) {
    return {
      identity: {
        mode: "test",
        runtime: dependencies.runtime ?? `node-v${process.versions.node}`,
        sourceCommit: "f".repeat(40),
        playwrightVersion: "test",
        chromiumVersion: "test",
        artifactSha256: EXECUTING_ARTIFACT_SHA256,
      },
      dirtyPaths: [],
    };
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const dirtyOutput = execFileSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
      "--",
      "scripts",
      "src",
      "retailers",
      "ops/validator-bundle.sha256",
      "package.json",
      "package-lock.json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const dirtyPaths = dirtyOutput === ""
    ? []
    : dirtyOutput.split("\0").filter((entry) => entry !== "").map((entry) => {
        // Porcelain v1 records a two-column status, one space, then the path.
        // Rename/copy entries are rejected below rather than trying to accept
        // either side of an ambiguous mutation.
        if (entry.length < 4 || entry[2] !== " ") {
          throw new Error("Trusted validation could not parse implementation-tree status");
        }
        return entry.slice(3);
      });
  const buildManifestPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../build-manifest.json",
  );
  const buildManifest = JSON.parse(readFileSync(buildManifestPath, "utf8")) as {
    schemaVersion?: unknown;
    sourceCommit?: unknown;
    sourceClean?: unknown;
    files?: unknown;
  };
  const artifact = Array.isArray(buildManifest.files)
    ? buildManifest.files.find((candidate) =>
      typeof candidate === "object"
      && candidate !== null
      && (candidate as { path?: unknown }).path === "scripts/validate-strategies.js")
    : undefined;
  if (
    buildManifest.schemaVersion !== 1
    || buildManifest.sourceCommit !== sourceCommit
    || buildManifest.sourceClean !== true
    || typeof artifact !== "object"
    || artifact === null
    || (artifact as { sha256?: unknown }).sha256 !== EXECUTING_ARTIFACT_SHA256
    || readTrustedValidatorArtifactSha256(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../ops/validator-bundle.sha256"),
    ) !== EXECUTING_ARTIFACT_SHA256
  ) {
    throw new Error("Trusted validation executable is not bound to the clean source commit");
  }
  const require = createRequire(import.meta.url);
  const playwrightPackage = require("playwright/package.json") as { version?: unknown };
  if (typeof playwrightPackage.version !== "string") {
    throw new Error("Playwright version could not be resolved");
  }
  return {
    identity: {
      mode: "trusted-live-host",
      runtime: `node-v${process.versions.node}`,
      sourceCommit,
      playwrightVersion: playwrightPackage.version,
      chromiumVersion: execFileSync(chromium.executablePath(), ["--version"], {
        encoding: "utf8",
      }).trim(),
      artifactSha256: EXECUTING_ARTIFACT_SHA256,
    },
    dirtyPaths,
  };
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

async function requestBodyBytes(
  input: string | URL | Request,
  body: BodyInit | null | undefined,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  if (body === undefined || body === null) {
    if (!(input instanceof Request) || input.body === null) return null;
    const bytes = new Uint8Array(await input.clone().arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`Validation request body exceeds ${maximumBytes} bytes`);
    }
    return bytes;
  }
  let bytes: Uint8Array;
  if (typeof body === "string") {
    bytes = new TextEncoder().encode(body);
  } else if (body instanceof URLSearchParams) {
    bytes = new TextEncoder().encode(body.toString());
  } else if (body instanceof Blob) {
    bytes = new Uint8Array(await body.arrayBuffer());
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else {
    throw new Error("Validation cannot hash a streaming request body");
  }
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`Validation request body exceeds ${maximumBytes} bytes`);
  }
  return bytes;
}

async function responseBody(
  response: Response,
  maximumBytes: number,
): Promise<{ bytes: Uint8Array; body: string }> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`Validation response body exceeds ${maximumBytes} bytes`);
  }
  const clone = response.clone();
  if (clone.body === null) return { bytes: new Uint8Array(), body: "" };
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`Validation response body exceeds ${maximumBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, body: new TextDecoder().decode(bytes) };
}

class ExchangeRecorder {
  readonly exchanges: RecordedExchange[] = [];
  readonly fetch: FetchLike;
  readonly #underlyingFetch: FetchLike;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #clock: () => number;
  readonly #pacingMs: number;
  readonly #maxBodyBytes: number;
  #nextStart = 0;
  #logicalStartedAt = 0;
  #first = true;
  #gate = Promise.resolve();

  constructor(input: {
    fetch?: FetchLike;
    sleep: (milliseconds: number) => Promise<void>;
    clock: () => number;
    pacingMs: number;
    maxBodyBytes: number;
  }) {
    this.#underlyingFetch = input.fetch ?? globalThis.fetch;
    this.#sleep = input.sleep;
    this.#clock = input.clock;
    this.#pacingMs = input.pacingMs;
    this.#maxBodyBytes = input.maxBodyBytes;
    this.fetch = async (requestInput, init) => {
      const method = (init?.method
        ?? (requestInput instanceof Request ? requestInput.method : "GET")).toUpperCase();
      if (method !== "GET" && method !== "POST") {
        throw new Error(`Validation evidence does not support ${method} requests`);
      }
      const bytes = await requestBodyBytes(
        requestInput,
        init?.body,
        this.#maxBodyBytes,
      );
      const request = {
        method,
        url: requestUrl(requestInput),
        bodySha256: bytes === null ? null : sha256(bytes),
      } as ValidationSample["request"];
      try {
        const response = await this.#underlyingFetch(requestInput, init);
        try {
          const captured = await responseBody(response, this.#maxBodyBytes);
          this.exchanges.push({
            request,
            response: {
              finalUrl: response.url || request.url,
              statusCode: response.status,
              contentType: response.headers.get("content-type")
                ?? "application/octet-stream",
              bodyBytes: captured.bytes.byteLength,
              bodySha256: sha256(captured.bytes),
            },
            body: captured.body,
            captureError: null,
            logicalStartedAt: this.#logicalStartedAt,
            mainDocument: false,
          });
        } catch (error) {
          this.exchanges.push({
            request,
            response: null,
            body: null,
            captureError: error instanceof Error ? error.message : String(error),
            logicalStartedAt: this.#logicalStartedAt,
            mainDocument: false,
          });
        }
        return response;
      } catch (error) {
        this.exchanges.push({
          request,
          response: null,
          body: null,
          captureError: null,
          logicalStartedAt: this.#logicalStartedAt,
          mainDocument: false,
        });
        throw error;
      }
    };
  }

  async pace(): Promise<number> {
    let startedAt = 0;
    const turn = this.#gate.then(async () => {
      let current = this.#clock();
      if (this.#first) {
        this.#first = false;
        this.#nextStart = current;
        this.#logicalStartedAt = current;
        startedAt = current;
        return;
      }
      const deadline = this.#nextStart + this.#pacingMs;
      while (current < deadline) {
        await this.#sleep(Math.max(1, Math.ceil(deadline - current)));
        current = this.#clock();
      }
      // Pace from the observed start, not the prior ideal deadline. A timer may
      // wake fractionally early or late; only the observed monotonic timestamp
      // can prove that consecutive request starts are far enough apart.
      this.#nextStart = current;
      this.#logicalStartedAt = current;
      startedAt = current;
    });
    this.#gate = turn.catch(() => undefined);
    await turn;
    return startedAt;
  }

  markMainDocument(input: {
    finalUrl: string;
    statusCode: number;
    body: Uint8Array;
  }): void {
    const bodySha256 = sha256(input.body);
    const exchange = this.exchanges.findLast((candidate) =>
      candidate.response?.finalUrl === input.finalUrl
      && candidate.response.statusCode === input.statusCode
      && candidate.response.bodySha256 === bodySha256);
    if (exchange === undefined) {
      throw new Error("Main-document response was absent from the validation recorder");
    }
    exchange.mainDocument = true;
  }

  mainDocumentFor(url: string): RecordedExchange | undefined {
    return this.exchanges.findLast((exchange) =>
      exchange.mainDocument && exchange.response?.finalUrl === url);
  }
}

function authoritativeRefs(
  database: Database.Database,
  retailerId: string,
): ProductRef[] {
  return selectStrategyValidationChallenge(database, retailerId, SAMPLE_SIZE);
}

function refKey(ref: ProductRef): string {
  return canonicalEvidenceJson({
    canonicalUrl: ref.canonicalUrl,
    externalId: ref.externalId,
  });
}

function selectExchange(
  recorder: ExchangeRecorder,
  strategy: DiscoveryStrategy | ExtractionStrategy,
  from = 0,
): RecordedExchange | undefined {
  const exchanges = recorder.exchanges.slice(from);
  const browserStrategy = strategy.tier === "dom-crawl"
    || strategy.tier === "dom"
    || strategy.tier === "script";
  if (!browserStrategy) return exchanges.at(-1);
  if (browserStrategy) {
    const mainDocuments = exchanges.filter((exchange) => exchange.mainDocument);
    if (mainDocuments.length > 0) return mainDocuments.at(-1);
  }
  return exchanges.at(-1);
}

function normalizedFailure(
  failure: ExtractionFailure | undefined,
  response: ResponseEvidence | null,
): ValidationSample["outcome"] {
  const fallback: ExtractionFailure = {
    category: "unknown",
    message: "Strategy returned no normalized result",
    responded: response !== null,
    ...(response === null ? {} : { statusCode: response.statusCode }),
  };
  const selected = failure ?? fallback;
  const redactedMessage = redact(selected.message);
  return {
    status: "invalid",
    failure: {
      category: selected.category,
      message: typeof redactedMessage === "string" && redactedMessage.trim() !== ""
        ? redactedMessage.trim()
        : "Strategy validation failed",
      responded: selected.responded,
      statusCode: selected.statusCode ?? (selected.responded
        ? response?.statusCode ?? null
        : null),
    },
  };
}

function scalarId(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function structuredIds(document: unknown): Set<string> {
  const ids = new Set<string>();
  const queue: unknown[] = [document];
  let visited = 0;
  while (queue.length > 0 && visited < 20_000) {
    const value = queue.shift();
    visited += 1;
    if (Array.isArray(value)) {
      queue.push(...value.slice(0, 5_000));
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:id|productId|product_id|sku)$/iu.test(key)) {
        const id = scalarId(child);
        if (id !== null) ids.add(id);
      }
      if (child !== null && typeof child === "object") queue.push(child);
    }
  }
  return ids;
}

function returnedFacts(
  strategy: DiscoveryStrategy | ExtractionStrategy,
  ref: ProductRef,
  exchange: RecordedExchange,
  outcome: ValidationSample["outcome"],
): ValidationSample["validatedFacts"] {
  if (exchange.response === null || exchange.body === null) {
    return {
      returnedProductId: null,
      catalogSellerId: null,
      catalogSellerMatchCount: null,
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(exchange.body);
  } catch {
    return {
      returnedProductId: null,
      catalogSellerId: null,
      catalogSellerMatchCount: null,
    };
  }
  const ids = structuredIds(document);
  const returnedProductId = ref.externalId !== null && ids.has(ref.externalId)
    ? ref.externalId
    : strategy.purpose === "extraction"
      ? [...ids].find((id) => !id.startsWith("gid://")) ?? null
      : null;
  const expectedSeller = strategy.purpose === "extraction" && strategy.tier === "api"
    ? strategy.regionalContext?.catalogSellerId
    : undefined;
  if (expectedSeller === undefined) {
    return {
      returnedProductId,
      catalogSellerId: null,
      catalogSellerMatchCount: null,
    };
  }
  const products = Array.isArray(document) ? document : [];
  const product = products.find((candidate) =>
    candidate !== null
    && typeof candidate === "object"
    && scalarId((candidate as Record<string, unknown>).productId) === ref.externalId);
  const firstItem = product !== null && typeof product === "object"
    && Array.isArray((product as Record<string, unknown>).items)
    ? ((product as Record<string, unknown>).items as unknown[])[0]
    : undefined;
  const sellers = firstItem !== null && typeof firstItem === "object"
    && Array.isArray((firstItem as Record<string, unknown>).sellers)
    ? (firstItem as Record<string, unknown>).sellers as unknown[]
    : [];
  const matchCount = sellers.filter((seller) =>
    seller !== null
    && typeof seller === "object"
    && scalarId((seller as Record<string, unknown>).sellerId) === expectedSeller).length;
  // Invalid JSON/identity failures may honestly have no response facts. Other
  // responded outcomes retain any seller fact so the validator can verify it.
  const hasIdentityEvidence = returnedProductId === ref.externalId && matchCount > 0;
  if (outcome.status === "invalid" && !hasIdentityEvidence) {
    return {
      returnedProductId: null,
      catalogSellerId: null,
      catalogSellerMatchCount: null,
    };
  }
  return {
    returnedProductId,
    catalogSellerId: expectedSeller,
    catalogSellerMatchCount: matchCount,
  };
}

function makeSample(input: {
  ordinal: number;
  startedOffsetMs: number;
  durationMs: number;
  ref: ProductRef;
  exchange: RecordedExchange;
  outcome: ValidationSample["outcome"];
  strategy: DiscoveryStrategy | ExtractionStrategy;
}): ValidationSample {
  if (input.exchange.captureError !== null) {
    throw new Error(input.exchange.captureError);
  }
  const requestSha256 = evidenceValueSha256(input.exchange.request);
  const outcomeSha256 = evidenceValueSha256(input.outcome);
  return {
    ordinal: input.ordinal,
    startedOffsetMs: input.startedOffsetMs,
    durationMs: input.durationMs,
    ref: input.ref,
    refSha256: validationRefSha256(input.ref),
    request: input.exchange.request,
    requestSha256,
    response: input.exchange.response,
    outcome: input.outcome,
    outcomeSha256,
    validatedFacts: returnedFacts(
      input.strategy,
      input.ref,
      input.exchange,
      input.outcome,
    ),
  };
}

function robotsOrigins(strategy: DiscoveryStrategy): string[] {
  const urls = strategy.tier === "sitemap"
    ? strategy.sitemapUrls
    : strategy.tier === "dom-crawl"
      ? strategy.startUrls
      : [];
  return [...new Set(urls.map((url) => new URL(url).origin))];
}

async function robotsContext(
  strategy: DiscoveryStrategy,
  recorder: ExchangeRecorder,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<{
  robots?: RobotsPolicy;
  robotsByOrigin?: ReadonlyMap<string, RobotsPolicy>;
}> {
  const origins = robotsOrigins(strategy);
  if (origins.length === 0) return {};
  const robotsByOrigin = new Map<string, RobotsPolicy>();
  for (const origin of origins) {
    const robotsUrl = new URL("/robots.txt", origin).toString();
    await recorder.pace();
    const fetched = await fetchBounded(
      { method: "GET", url: robotsUrl },
      strategy.allowedDomains,
      { fetch: recorder.fetch, timeoutMs, maxBodyBytes },
    );
    if (!fetched.ok) throw new DiscoveryFailureError(fetched.failure);
    if (new URL(fetched.response.url).origin !== origin) {
      throw new Error(`Robots response escaped ${origin}`);
    }
    robotsByOrigin.set(origin, RobotsPolicy.parse(robotsUrl, fetched.response.body));
  }
  const single = robotsByOrigin.size === 1
    ? robotsByOrigin.values().next().value
    : undefined;
  return {
    ...(single === undefined ? {} : { robots: single }),
    robotsByOrigin,
  };
}

async function discoverySamples(
  config: RetailerConfig,
  refs: readonly ProductRef[],
  recorder: ExchangeRecorder,
  dependencies: ValidationRunDependencies,
  timeoutMs: number,
  maxBodyBytes: number,
  runStartedAt: number,
): Promise<ValidationSample[]> {
  const challenge = refs.slice(0, SAMPLE_SIZE);
  const challengeByKey = new Map(challenge.map((ref) => [refKey(ref), ref]));
  const matches = new Map<string, RecordedExchange>();
  const documentExchanges = new Map<string, RecordedExchange>();
  const policies = await robotsContext(
    config.discovery,
    recorder,
    timeoutMs,
    maxBodyBytes,
  );
  const iterable = executeDiscovery(config.discovery, {
    fetch: recorder.fetch,
    ...(dependencies.browser === undefined ? {} : { browser: dependencies.browser }),
    timeoutMs,
    totalTimeoutMs: Math.max(timeoutMs, DISCOVERY_VALIDATION_TIMEOUT_MS),
    maxBodyBytes,
    stopAfterProducts: 3_000,
    beforeRequest: async () => {
      await recorder.pace();
    },
    onMainDocumentResponse: (evidence) => recorder.markMainDocument(evidence),
    reportRefDocument: (ref, documentUrl) => {
      const exchange = recorder.mainDocumentFor(documentUrl);
      if (exchange === undefined) {
        throw new Error(`No main-document evidence exists for ${documentUrl}`);
      }
      documentExchanges.set(refKey(ref), exchange);
    },
    ...policies,
  });
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (matches.size < challenge.length) {
      const next = await iterator.next();
      if (next.done) break;
      const key = refKey(next.value);
      if (!challengeByKey.has(key) || matches.has(key)) continue;
      const exchange = config.discovery.tier === "dom-crawl"
        ? documentExchanges.get(key)
        : selectExchange(recorder, config.discovery);
      if (exchange === undefined || exchange.response === null) {
        throw new Error("Discovery yielded a reference without response evidence");
      }
      matches.set(key, exchange);
    }
  } finally {
    await iterator.return?.(undefined);
  }
  const fallbackExchange = selectExchange(recorder, config.discovery);
  if (fallbackExchange === undefined || fallbackExchange.response === null) {
    throw new Error(`${config.id} discovery produced no auditable challenge response`);
  }
  return challenge.map((ref, index) => {
    const exchange = matches.get(refKey(ref)) ?? fallbackExchange;
    const found = matches.has(refKey(ref));
    const outcome: ValidationSample["outcome"] = found
      ? { status: "valid", fields: null }
      : {
          status: "invalid",
          failure: {
            category: "missing-fields",
            message: "Preselected authoritative discovery challenge reference was not rediscovered",
            responded: true,
            statusCode: exchange.response?.statusCode ?? null,
          },
        };
    return makeSample({
      ordinal: index + 1,
      startedOffsetMs: Math.max(
        0,
        Math.round(exchange.logicalStartedAt - runStartedAt),
      ),
      durationMs: Math.max(
        0,
        Math.round(clockNow(dependencies) - exchange.logicalStartedAt),
      ),
      ref,
      exchange,
      outcome,
      strategy: config.discovery,
    });
  });
}

async function extractionSamples(
  config: RetailerConfig,
  refs: readonly ProductRef[],
  recorder: ExchangeRecorder,
  dependencies: ValidationRunDependencies,
  timeoutMs: number,
  maxBodyBytes: number,
  runStartedAt: number,
): Promise<ValidationSample[]> {
  const samples: ValidationSample[] = [];
  for (const ref of refs.slice(0, SAMPLE_SIZE)) {
    const exchangeStart = recorder.exchanges.length;
    const logicalStartedAt = await recorder.pace();
    const result: ExtractionResult = await executeExtraction(config.extraction, ref, {
      fetch: recorder.fetch,
      ...(dependencies.browser === undefined ? {} : { browser: dependencies.browser }),
      timeoutMs,
      totalTimeoutMs: timeoutMs,
      maxBodyBytes,
      onMainDocumentResponse: (evidence) => recorder.markMainDocument(evidence),
    });
    const durationMs = Math.max(
      0,
      Math.round(clockNow(dependencies) - logicalStartedAt),
    );
    const exchange = selectExchange(recorder, config.extraction, exchangeStart);
    if (exchange === undefined) {
      throw new Error(`${config.id} extraction made no auditable request for ${ref.canonicalUrl}`);
    }
    const validationFailure = extractionValidationFailureReason(result);
    const outcome: ValidationSample["outcome"] = validationFailure === undefined
      && result.fields !== undefined
      ? { status: "valid", fields: result.fields }
      : normalizedFailure(result.failure ?? {
        category: "missing-fields",
        message: validationFailure ?? "Extraction returned no valid fields",
        responded: exchange.response !== null,
        ...(exchange.response === null
          ? {}
          : { statusCode: exchange.response.statusCode }),
      }, exchange.response);
    samples.push(makeSample({
      ordinal: samples.length + 1,
      startedOffsetMs: Math.max(0, Math.round(logicalStartedAt - runStartedAt)),
      durationMs,
      ref,
      exchange,
      outcome,
      strategy: config.extraction,
    }));
  }
  return samples;
}

async function writeCanonicalAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = `${canonicalEvidenceJson(value)}\n`;
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const existing = await readFile(path, "utf8");
      if (existing !== content) {
        throw new Error(
          `Validation receipt ${path} already exists with different immutable evidence; `
          + "create a successor strategy version",
        );
      }
    }
    await rm(temporary, { force: true });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeConfigAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function canonicalReceiptPath(
  outputDirectory: string,
  config: RetailerConfig,
  purpose: Purpose,
): string {
  return resolve(
    outputDirectory,
    `${config.id}-${purpose}-v${config.strategyVersions[purpose]}.json`,
  );
}

function failedAttemptPath(
  outputDirectory: string,
  config: RetailerConfig,
  purpose: Purpose,
): string {
  return resolve(
    outputDirectory,
    "attempts",
    `${config.id}-${purpose}-v${config.strategyVersions[purpose]}.json`,
  );
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validatedReceiptBinding(input: {
  evidence: unknown;
  path: string;
  config: RetailerConfig;
  purpose: Purpose;
  refs: readonly ProductRef[];
  identity: ValidatorExecutorIdentity;
  verificationPublicKey: KeyObject;
}): StrategyValidationEvidence {
  let evidence: StrategyValidationEvidence;
  try {
    evidence = validateStrategyEvidence(input.evidence, {
      retailerId: input.config.id,
      purpose: input.purpose,
      strategyVersion: input.config.strategyVersions[input.purpose],
      strategy: input.config[input.purpose],
      verificationPublicKey: input.verificationPublicKey,
      authoritativeRefs: input.refs,
    });
  } catch (error) {
    throw new Error(
      `Validation receipt ${input.path} does not match the immutable rollout`,
      { cause: error },
    );
  }
  if (
    evidence.executor.mode !== input.identity.mode
    || evidence.executor.sourceCommit !== input.identity.sourceCommit
    || evidence.executor.artifactSha256 !== input.identity.artifactSha256
    || evidence.executor.challengeAlgorithm !== VALIDATION_CHALLENGE_ALGORITHM
    || canonicalEvidenceJson(evidence.samples.map(({ ref }) => ref))
      !== canonicalEvidenceJson(input.refs)
  ) {
    throw new Error(
      `Validation receipt ${input.path} is bound to a different source, `
      + "validator artifact, or independent challenge",
    );
  }
  return evidence;
}

async function reusableValidationReceipt(input: {
  path: string;
  config: RetailerConfig;
  purpose: Purpose;
  refs: readonly ProductRef[];
  identity: ValidatorExecutorIdentity;
  verificationPublicKey: KeyObject;
}): Promise<ValidationRunResult | null> {
  let raw: string;
  try {
    const status = await lstat(input.path);
    if (!status.isFile()) {
      throw new Error(`Validation receipt ${input.path} is not a regular file`);
    }
    raw = await readFile(input.path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  const evidence = validatedReceiptBinding({ ...input, evidence: JSON.parse(raw) });
  return { path: input.path, evidence };
}

interface FailedAttemptManifestEntry {
  path: string;
  fileSha256: string;
  receiptSha256: string;
  strategySourceCommit: string;
}

async function registerFailedValidationAttempt(input: {
  outputDirectory: string;
  path: string;
  evidence: StrategyValidationEvidence;
}): Promise<void> {
  if (
    input.evidence.executor.mode !== "trusted-live-host"
    || input.evidence.activatable
  ) {
    return;
  }
  const attemptsDirectory = resolve(input.outputDirectory, "attempts");
  const manifestPath = join(attemptsDirectory, "manifest.json");
  const projectPath = relative(process.cwd(), input.path).split(sep).join("/");
  if (projectPath.startsWith("../") || projectPath === "..") {
    throw new Error("Failed-attempt evidence must remain inside the project tree");
  }
  const raw = await readFile(input.path);
  const entry: FailedAttemptManifestEntry = {
    path: projectPath,
    fileSha256: sha256(raw),
    receiptSha256: validationReceiptSha256(input.evidence),
    strategySourceCommit: input.evidence.executor.sourceCommit,
  };
  let attempts: FailedAttemptManifestEntry[] = [];
  try {
    const status = await lstat(manifestPath);
    if (!status.isFile()) throw new Error("Failed-attempt manifest is not a regular file");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
      attempts?: unknown;
    };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.attempts)) {
      throw new Error("Failed-attempt manifest is malformed");
    }
    attempts = parsed.attempts.map((candidate) => {
      if (
        candidate === null
        || typeof candidate !== "object"
        || Object.keys(candidate).sort().join("\0")
          !== ["fileSha256", "path", "receiptSha256", "strategySourceCommit"]
            .sort().join("\0")
      ) {
        throw new Error("Failed-attempt manifest contains a malformed entry");
      }
      const value = candidate as Record<string, unknown>;
      if (
        typeof value.path !== "string"
        || typeof value.fileSha256 !== "string"
        || typeof value.receiptSha256 !== "string"
        || typeof value.strategySourceCommit !== "string"
      ) {
        throw new Error("Failed-attempt manifest contains a malformed entry");
      }
      return value as unknown as FailedAttemptManifestEntry;
    });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const existing = attempts.find((candidate) => candidate.path === entry.path);
  if (existing !== undefined && canonicalEvidenceJson(existing) !== canonicalEvidenceJson(entry)) {
    throw new Error(
      `Failed validation attempt ${entry.path} already binds different immutable evidence; `
      + "create a successor strategy version",
    );
  }
  if (existing === undefined) attempts.push(entry);
  attempts.sort((left, right) => left.path.localeCompare(right.path));
  await writeConfigAtomic(manifestPath, { schemaVersion: 1, attempts });
}

async function validateConfiguredStrategyWithIdentity(
  config: RetailerConfig,
  purpose: Purpose,
  dependencies: ValidationRunDependencies,
  identity: ValidatorExecutorIdentity,
  selectedRefs?: readonly ProductRef[],
): Promise<ValidationRunResult> {
  if (!config.active) throw new Error(`Retailer ${config.id} is not active`);
  const refs = selectedRefs ?? authoritativeRefs(dependencies.database, config.id);
  if (refs.length < SAMPLE_SIZE) {
    throw new Error(
      `${config.id} has ${refs.length}/${SAMPLE_SIZE} authoritative in-scope product references`,
    );
  }
  const verificationPublicKey = createPublicKey(dependencies.signingPrivateKey);
  const canonicalPath = canonicalReceiptPath(dependencies.outputDirectory, config, purpose);
  const existingCanonical = await reusableValidationReceipt({
    path: canonicalPath,
    config,
    purpose,
    refs,
    identity,
    verificationPublicKey,
  });
  if (existingCanonical !== null) return existingCanonical;
  if (identity.mode === "trusted-live-host") {
    const attemptPath = failedAttemptPath(dependencies.outputDirectory, config, purpose);
    const existingAttempt = await reusableValidationReceipt({
      path: attemptPath,
      config,
      purpose,
      refs,
      identity,
      verificationPublicKey,
    });
    if (existingAttempt !== null) {
      if (existingAttempt.evidence.activatable) {
        throw new Error(`Activatable evidence is forbidden in failed-attempt path ${attemptPath}`);
      }
      await registerFailedValidationAttempt({
        outputDirectory: dependencies.outputDirectory,
        path: attemptPath,
        evidence: existingAttempt.evidence,
      });
      return existingAttempt;
    }
  }
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const pacingMs = Math.max(
    MINIMUM_PACING_MS,
    dependencies.pacingMs ?? config.politeDelayMs.min,
  );
  const now = dependencies.now ?? (() => new Date());
  const executionStartedAt = now();
  const monotonicStartedAt = clockNow(dependencies);
  const recorder = new ExchangeRecorder({
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    sleep: dependencies.sleep ?? ((milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
    clock: dependencies.clock ?? (() => performance.now()),
    pacingMs,
    maxBodyBytes,
  });
  const samples = purpose === "discovery"
    ? await discoverySamples(
      config,
      refs,
      recorder,
      dependencies,
      timeoutMs,
      maxBodyBytes,
      monotonicStartedAt,
    )
    : await extractionSamples(
      config,
      refs,
      recorder,
      dependencies,
      timeoutMs,
      maxBodyBytes,
      monotonicStartedAt,
    );
  const valid = samples.filter((sample) => sample.outcome.status === "valid").length;
  const score = valid / SAMPLE_SIZE;
  const elapsedMs = Math.max(0, Math.round(clockNow(dependencies) - monotonicStartedAt));
  const finishedAt = now().toISOString();
  const evidence = validateStrategyEvidence(attestStrategyValidationEvidence({
    schemaVersion: 2,
    retailerId: config.id,
    purpose,
    strategyVersion: config.strategyVersions[purpose],
    strategySha256: strategyEvidenceSha256(config[purpose]),
    validatedAt: finishedAt,
    executor: {
      program: "scripts/validate-strategies.ts",
      version: 1,
      mode: identity.mode,
      runtime: identity.runtime,
      sourceCommit: identity.sourceCommit,
      playwrightVersion: identity.playwrightVersion,
      chromiumVersion: identity.chromiumVersion,
      artifactSha256: identity.artifactSha256,
      challengeAlgorithm: VALIDATION_CHALLENGE_ALGORITHM,
      sequentialPacingMs: pacingMs,
      timeoutMs,
      maxBodyBytes,
      startedAt: executionStartedAt.toISOString(),
      finishedAt,
      elapsedMs,
      requestHeadersStored: false,
      responseBodiesStored: false,
    },
    attempted: SAMPLE_SIZE,
    valid,
    score,
    activatable: identity.mode === "trusted-live-host" && score >= 0.9,
    sampleSetSha256: validationSampleSetSha256(samples),
    samples,
  }, dependencies.signingPrivateKey), {
    retailerId: config.id,
    purpose,
    strategyVersion: config.strategyVersions[purpose],
    strategy: config[purpose],
    verificationPublicKey,
    authoritativeRefs: refs,
  });
  const path = identity.mode === "trusted-live-host" && !evidence.activatable
    ? failedAttemptPath(dependencies.outputDirectory, config, purpose)
    : canonicalPath;
  await writeCanonicalAtomic(path, evidence);
  await registerFailedValidationAttempt({
    outputDirectory: dependencies.outputDirectory,
    path,
    evidence,
  });
  return { path, evidence };
}

export async function validateConfiguredStrategy(
  config: RetailerConfig,
  purpose: Purpose,
  dependencies: ValidationRunDependencies,
): Promise<ValidationRunResult> {
  const inspection = executorIdentity(dependencies);
  if (inspection.dirtyPaths.length > 0) {
    throw new Error("Trusted validation requires a clean committed implementation tree");
  }
  return validateConfiguredStrategyWithIdentity(
    config,
    purpose,
    dependencies,
    inspection.identity,
  );
}

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const RolloutEntryCoreSchema = z.object({
  retailerId: z.string().min(1),
  purpose: z.enum(["discovery", "extraction"]),
  strategyVersion: z.number().int().positive(),
  strategySha256: Sha256Schema,
  challengeSha256: Sha256Schema,
  configCoreSha256: Sha256Schema,
  configPath: z.string().min(1),
  receiptPath: z.string().min(1),
  configReceiptPath: z.string().min(1),
}).strict();
const RolloutCoreSchema = z.object({
  schemaVersion: z.literal(1),
  sourceCommit: CommitSchema,
  validatorArtifactSha256: Sha256Schema,
  validatorKeyId: Sha256Schema,
  challengeAlgorithm: z.literal(VALIDATION_CHALLENGE_ALGORITHM),
  entries: z.array(RolloutEntryCoreSchema).min(1),
}).strict();
const RolloutStateSchema = z.object({
  retailerId: z.string().min(1),
  purpose: z.enum(["discovery", "extraction"]),
  phase: z.enum(["pending", "receipt-published", "config-bound", "activated", "failed"]),
  receiptPath: z.string().min(1).nullable(),
  receiptSha256: Sha256Schema.nullable(),
}).strict();
const RolloutJournalPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  rolloutId: Sha256Schema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  core: RolloutCoreSchema,
  states: z.array(RolloutStateSchema).min(1),
}).strict();
const RolloutJournalSchema = z.object({
  payload: RolloutJournalPayloadSchema,
  attestation: z.object({
    algorithm: z.literal("ed25519"),
    keyId: Sha256Schema,
    payloadSha256: Sha256Schema,
    signature: z.string().min(1),
  }).strict(),
}).strict();

type RolloutCore = z.infer<typeof RolloutCoreSchema>;
type RolloutJournal = z.infer<typeof RolloutJournalSchema>;
type RolloutState = z.infer<typeof RolloutStateSchema>;
export type ValidationRolloutPhase = "receipt" | "config" | "activation";

function rolloutStateKey(input: { retailerId: string; purpose: Purpose }): string {
  return `${input.retailerId}/${input.purpose}`;
}

function normalizedConfigCoreSha256(
  config: RetailerConfig,
  selectedPurposes: readonly Purpose[],
): string {
  const normalized = JSON.parse(JSON.stringify(config)) as {
    validation: Record<Purpose, Record<string, unknown>>;
  };
  for (const purpose of selectedPurposes) {
    normalized.validation[purpose] = {
      ...normalized.validation[purpose],
      externallyValidated: false,
      validatedAt: null,
      sampleSize: 0,
      successes: 0,
      score: 0,
      receiptSha256: null,
    };
  }
  return evidenceValueSha256(normalized);
}

function attestRolloutJournal(
  payload: z.infer<typeof RolloutJournalPayloadSchema>,
  privateKey: KeyObject,
): RolloutJournal {
  const canonical = canonicalEvidenceJson(payload);
  return RolloutJournalSchema.parse({
    payload,
    attestation: {
      algorithm: "ed25519",
      keyId: validationAttestationKeyId(privateKey),
      payloadSha256: sha256(canonical),
      signature: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  });
}

function verifyRolloutJournal(
  input: unknown,
  expectedCore: RolloutCore,
  verificationPublicKey: KeyObject,
): RolloutJournal {
  const journal = RolloutJournalSchema.parse(input);
  const canonical = canonicalEvidenceJson(journal.payload);
  if (
    journal.payload.rolloutId !== evidenceValueSha256(expectedCore)
    || canonicalEvidenceJson(journal.payload.core) !== canonicalEvidenceJson(expectedCore)
    || journal.attestation.keyId !== validationAttestationKeyId(verificationPublicKey)
    || journal.attestation.payloadSha256 !== sha256(canonical)
    || !verify(
      null,
      Buffer.from(canonical),
      verificationPublicKey,
      Buffer.from(journal.attestation.signature, "base64"),
    )
  ) {
    throw new Error("Validation rollout journal is not bound to the selected immutable rollout");
  }
  const expectedKeys = expectedCore.entries.map(rolloutStateKey).sort();
  const stateKeys = journal.payload.states.map(rolloutStateKey).sort();
  if (
    new Set(stateKeys).size !== stateKeys.length
    || canonicalEvidenceJson(stateKeys) !== canonicalEvidenceJson(expectedKeys)
  ) {
    throw new Error("Validation rollout journal has incomplete or duplicate state coverage");
  }
  return journal;
}

async function readRolloutJournal(
  path: string,
  core: RolloutCore,
  verificationPublicKey: KeyObject,
): Promise<RolloutJournal | null> {
  try {
    const status = await lstat(path);
    if (!status.isFile()) throw new Error("Validation rollout journal is not a regular file");
    return verifyRolloutJournal(
      JSON.parse(await readFile(path, "utf8")),
      core,
      verificationPublicKey,
    );
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function writeRolloutJournal(
  path: string,
  journal: RolloutJournal,
): Promise<void> {
  await writeConfigAtomic(path, journal);
}

function updateRolloutState(
  journal: RolloutJournal,
  identity: { retailerId: string; purpose: Purpose },
  update: Pick<RolloutState, "phase" | "receiptPath" | "receiptSha256">,
  privateKey: KeyObject,
): RolloutJournal {
  const key = rolloutStateKey(identity);
  const existing = journal.payload.states.find((state) => rolloutStateKey(state) === key);
  if (existing === undefined) throw new Error(`Rollout journal is missing ${key}`);
  const order: Record<Exclude<RolloutState["phase"], "failed">, number> = {
    pending: 0,
    "receipt-published": 1,
    "config-bound": 2,
    activated: 3,
  };
  if (existing.phase === "failed" && update.phase !== "failed") {
    throw new Error(`Failed validation rollout entry ${key} requires a successor version`);
  }
  if (
    update.phase !== "failed"
    && existing.phase !== "failed"
    && order[update.phase] < order[existing.phase]
  ) {
    return journal;
  }
  return attestRolloutJournal({
    ...journal.payload,
    updatedAt: new Date().toISOString(),
    states: journal.payload.states.map((state) => rolloutStateKey(state) === key
      ? { ...state, ...update }
      : state),
  }, privateKey);
}

function configReceiptPath(config: RetailerConfig, purpose: Purpose): string {
  return `data/validation/${config.id}-${purpose}-v${config.strategyVersions[purpose]}.json`;
}

function activationMatches(
  database: Database.Database,
  completed: ReadonlyArray<{
    config: RetailerConfig;
    purpose: Purpose;
    result: ValidationRunResult;
  }>,
): boolean {
  return completed.every(({ config, purpose, result }) => {
    const row = database.prepare(`
      SELECT strategy.retailer_id AS retailerId,
             strategy.purpose,
             strategy.version,
             strategy.strategy_json AS strategyJson,
             strategy.active,
             strategy.validation_sample_size AS sampleSize,
             strategy.validation_successes AS successes,
             strategy.validation_rate AS score,
             strategy.validated_at AS validatedAt,
             evidence.receipt_path AS receiptPath,
             evidence.receipt_sha256 AS receiptSha256,
             evidence.sample_set_sha256 AS sampleSetSha256,
             evidence.attestation_key_id AS attestationKeyId
      FROM strategies AS strategy
      LEFT JOIN strategy_validation_evidence AS evidence
        ON evidence.strategy_id = strategy.id
      WHERE strategy.id = ?
    `).get(`${config.id}-${purpose}-v${config.strategyVersions[purpose]}`) as {
      retailerId: string;
      purpose: string;
      version: number;
      strategyJson: string;
      active: number;
      sampleSize: number;
      successes: number;
      score: number | null;
      validatedAt: string | null;
      receiptPath: string | null;
      receiptSha256: string | null;
      sampleSetSha256: string | null;
      attestationKeyId: string | null;
    } | undefined;
    return row !== undefined
      && row.retailerId === config.id
      && row.purpose === purpose
      && row.version === config.strategyVersions[purpose]
      && row.strategyJson === JSON.stringify(config[purpose])
      && row.active === 1
      && row.sampleSize === result.evidence.attempted
      && row.successes === result.evidence.valid
      && row.score === result.evidence.score
      && row.validatedAt === result.evidence.validatedAt
      && row.receiptPath === configReceiptPath(config, purpose)
      && row.receiptSha256 === validationReceiptSha256(result.evidence)
      && row.sampleSetSha256 === result.evidence.sampleSetSha256
      && row.attestationKeyId === result.evidence.attestation.keyId;
  });
}

export interface ValidationRolloutOptions {
  configs: readonly RetailerConfig[];
  purposes: readonly Purpose[];
  configsDirectory: string;
  databasePath?: string;
  updateConfig: boolean;
  activate: boolean;
  validation: ValidationRunDependencies;
  /** Test-only seam for deterministic trusted-host crash recovery fixtures. */
  testExecutorIdentity?: ValidatorExecutorIdentity;
  /** Test-only seam; production always invokes the bundled validator. */
  testValidateStrategy?: (
    config: RetailerConfig,
    purpose: Purpose,
    refs: readonly ProductRef[],
  ) => Promise<ValidationRunResult>;
  /** Test-only seam; production uses registerRetailerConfigs itself. */
  testActivateConfigs?: (configs: readonly RetailerConfig[]) => void;
  phaseHook?: (input: {
    phase: ValidationRolloutPhase;
    retailerId: string | null;
    purpose: Purpose | null;
  }) => void | Promise<void>;
}

export async function executeValidationRollout(
  options: ValidationRolloutOptions,
): Promise<Array<{
  config: RetailerConfig;
  purpose: Purpose;
  result: ValidationRunResult;
}>> {
  if (options.activate && !options.updateConfig) {
    throw new Error("Activation requires config binding");
  }
  if (options.configs.length === 0 || options.purposes.length === 0) {
    throw new Error("A validation rollout requires at least one selected strategy");
  }
  const hasTestSeam = options.testExecutorIdentity !== undefined
    || options.testValidateStrategy !== undefined
    || options.testActivateConfigs !== undefined;
  if (
    hasTestSeam
    && (process.env.VITEST !== "true" || options.validation.database.name !== ":memory:")
  ) {
    throw new Error("Validation rollout test seams require an in-memory Vitest database");
  }
  const inspection: ValidatorExecutorInspection = options.testExecutorIdentity === undefined
    ? executorIdentity(options.validation)
    : { identity: options.testExecutorIdentity, dirtyPaths: [] };
  const verificationPublicKey = createPublicKey(options.validation.signingPrivateKey);
  const purposesByRetailer = new Map<string, Purpose[]>();
  for (const config of options.configs) purposesByRetailer.set(config.id, []);
  for (const config of options.configs) {
    const selected = purposesByRetailer.get(config.id);
    if (selected === undefined) throw new Error(`Missing rollout purpose set for ${config.id}`);
    selected.push(...options.purposes);
  }
  const refsByEntry = new Map<string, ProductRef[]>();
  const coreEntries: Array<z.infer<typeof RolloutEntryCoreSchema>> = [];
  for (const config of options.configs) {
    const selectedPurposes = purposesByRetailer.get(config.id) ?? [];
    const configPath = resolve(options.configsDirectory, `${config.id}.json`);
    for (const purpose of options.purposes) {
      const refs = authoritativeRefs(options.validation.database, config.id);
      if (refs.length !== SAMPLE_SIZE) {
        throw new Error(
          `${config.id} has ${refs.length}/${SAMPLE_SIZE} authoritative in-scope product references`,
        );
      }
      refsByEntry.set(rolloutStateKey({ retailerId: config.id, purpose }), refs);
      coreEntries.push({
        retailerId: config.id,
        purpose,
        strategyVersion: config.strategyVersions[purpose],
        strategySha256: strategyEvidenceSha256(config[purpose]),
        challengeSha256: evidenceValueSha256(refs),
        configCoreSha256: normalizedConfigCoreSha256(config, selectedPurposes),
        configPath,
        receiptPath: canonicalReceiptPath(options.validation.outputDirectory, config, purpose),
        configReceiptPath: configReceiptPath(config, purpose),
      });
    }
  }
  coreEntries.sort((left, right) => rolloutStateKey(left).localeCompare(rolloutStateKey(right)));
  const core = RolloutCoreSchema.parse({
    schemaVersion: 1,
    sourceCommit: inspection.identity.sourceCommit,
    validatorArtifactSha256: inspection.identity.artifactSha256,
    validatorKeyId: validationAttestationKeyId(verificationPublicKey),
    challengeAlgorithm: VALIDATION_CHALLENGE_ALGORITHM,
    entries: coreEntries,
  });
  const rolloutId = evidenceValueSha256(core);
  const journalPath = resolve(
    options.validation.outputDirectory,
    "rollouts",
    `${rolloutId}.json`,
  );
  let journal = await readRolloutJournal(journalPath, core, verificationPublicKey);
  const allowedDirtyPaths = new Set(core.entries.map(({ configPath }) =>
    relative(process.cwd(), configPath).split(sep).join("/")));
  if (
    inspection.dirtyPaths.some((path) => !allowedDirtyPaths.has(path))
    || (inspection.dirtyPaths.length > 0 && journal === null)
  ) {
    throw new Error(
      "Trusted validation requires a clean implementation tree or an exact signed rollout resume",
    );
  }
  if (journal === null) {
    const now = new Date().toISOString();
    journal = attestRolloutJournal({
      schemaVersion: 1,
      rolloutId,
      createdAt: now,
      updatedAt: now,
      core,
      states: core.entries.map(({ retailerId, purpose }) => ({
        retailerId,
        purpose,
        phase: "pending" as const,
        receiptPath: null,
        receiptSha256: null,
      })),
    }, options.validation.signingPrivateKey);
    await writeRolloutJournal(journalPath, journal);
  }

  const completed: Array<{
    config: RetailerConfig;
    purpose: Purpose;
    result: ValidationRunResult;
  }> = [];
  for (const config of options.configs) {
    for (const purpose of options.purposes) {
      const key = rolloutStateKey({ retailerId: config.id, purpose });
      const refs = refsByEntry.get(key);
      const coreEntry = core.entries.find((entry) => rolloutStateKey(entry) === key);
      const state = journal.payload.states.find((candidate) => rolloutStateKey(candidate) === key);
      if (refs === undefined || coreEntry === undefined || state === undefined) {
        throw new Error(`Rollout journal lost selected entry ${key}`);
      }
      let result = await reusableValidationReceipt({
        path: coreEntry.receiptPath,
        config,
        purpose,
        refs,
        identity: inspection.identity,
        verificationPublicKey,
      });
      if (result === null && state.phase === "failed" && state.receiptPath !== null) {
        result = await reusableValidationReceipt({
          path: state.receiptPath,
          config,
          purpose,
          refs,
          identity: inspection.identity,
          verificationPublicKey,
        });
      }
      if (result === null && state.phase !== "pending") {
        throw new Error(`Rollout journal claims ${key} evidence that is missing from disk`);
      }
      if (result === null) {
        result = options.testValidateStrategy === undefined
          ? await validateConfiguredStrategyWithIdentity(
              config,
              purpose,
              options.validation,
              inspection.identity,
              refs,
            )
          : await options.testValidateStrategy(config, purpose, refs);
        const validated = validatedReceiptBinding({
          evidence: result.evidence,
          path: result.path,
          config,
          purpose,
          refs,
          identity: inspection.identity,
          verificationPublicKey,
        });
        const expectedPath = validated.activatable
          ? coreEntry.receiptPath
          : failedAttemptPath(options.validation.outputDirectory, config, purpose);
        if (resolve(result.path) !== expectedPath) {
          throw new Error(`Validator returned noncanonical evidence path for ${key}`);
        }
        await writeCanonicalAtomic(expectedPath, validated);
        await registerFailedValidationAttempt({
          outputDirectory: options.validation.outputDirectory,
          path: expectedPath,
          evidence: validated,
        });
        result = { path: expectedPath, evidence: validated };
      }
      if (!result.evidence.activatable) {
        await registerFailedValidationAttempt({
          outputDirectory: options.validation.outputDirectory,
          path: result.path,
          evidence: result.evidence,
        });
      }
      const phase = result.evidence.activatable ? "receipt-published" : "failed";
      journal = updateRolloutState(journal, { retailerId: config.id, purpose }, {
        phase,
        receiptPath: result.path,
        receiptSha256: validationReceiptSha256(result.evidence),
      }, options.validation.signingPrivateKey);
      await writeRolloutJournal(journalPath, journal);
      completed.push({ config, purpose, result });
      await options.phaseHook?.({ phase: "receipt", retailerId: config.id, purpose });
    }
  }
  if (completed.some(({ result }) => !result.evidence.activatable)) {
    throw new Error(
      "Refusing to bind non-activatable validation evidence; create a successor strategy version",
    );
  }
  if (!options.updateConfig) return completed;

  for (const config of options.configs) {
    const items = completed.filter((candidate) => candidate.config.id === config.id);
    const validation = { ...config.validation };
    for (const item of items) {
      validation[item.purpose] = {
        ...validation[item.purpose],
        externallyValidated: true,
        validatedAt: item.result.evidence.validatedAt,
        sampleSize: item.result.evidence.attempted,
        successes: item.result.evidence.valid,
        score: item.result.evidence.score,
        receiptPath: configReceiptPath(config, item.purpose),
        receiptSha256: validationReceiptSha256(item.result.evidence),
      };
    }
    const desired = { ...config, validation };
    const configPath = resolve(options.configsDirectory, `${config.id}.json`);
    let current: unknown = null;
    try {
      current = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (canonicalEvidenceJson(current) !== canonicalEvidenceJson(desired)) {
      await writeConfigAtomic(configPath, desired);
    }
    for (const item of items) {
      journal = updateRolloutState(journal, {
        retailerId: item.config.id,
        purpose: item.purpose,
      }, {
        phase: "config-bound",
        receiptPath: item.result.path,
        receiptSha256: validationReceiptSha256(item.result.evidence),
      }, options.validation.signingPrivateKey);
    }
    await writeRolloutJournal(journalPath, journal);
    await options.phaseHook?.({ phase: "config", retailerId: config.id, purpose: null });
  }
  if (!options.activate) return completed;

  if (!activationMatches(options.validation.database, completed)) {
    const selectedRetailers = new Set(options.configs.map(({ id }) => id));
    const boundConfigs = loadRetailerConfigs(resolve(options.configsDirectory))
      .filter(({ id }) => selectedRetailers.has(id));
    if (options.testActivateConfigs !== undefined) {
      options.testActivateConfigs(boundConfigs);
    } else {
      if (options.databasePath === undefined) {
        throw new Error("A database path is required for production activation");
      }
      const writable = openDatabase(resolve(options.databasePath));
      try {
        registerRetailerConfigs(writable, boundConfigs, {
          projectRoot: dirname(resolve(options.configsDirectory)),
        });
      } finally {
        writable.close();
      }
    }
    if (!activationMatches(options.validation.database, completed)) {
      throw new Error("Strategy activation did not persist the exact rollout evidence");
    }
  }
  for (const item of completed) {
    journal = updateRolloutState(journal, {
      retailerId: item.config.id,
      purpose: item.purpose,
    }, {
      phase: "activated",
      receiptPath: item.result.path,
      receiptSha256: validationReceiptSha256(item.result.evidence),
    }, options.validation.signingPrivateKey);
  }
  await writeRolloutJournal(journalPath, journal);
  await options.phaseHook?.({ phase: "activation", retailerId: null, purpose: null });
  return completed;
}

interface CliOptions {
  retailer: string;
  purpose: "all" | Purpose;
  database: string;
  configs: string;
  outputDirectory: string;
  pacingMs?: string;
  timeoutMs: string;
  maxBodyBytes: string;
  signingPrivateKey: string;
  updateConfig?: boolean;
  activate?: boolean;
  prepareDiscoveryChallenge?: boolean;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const command = new Command()
    .description("Produce trusted live-host strategy validation receipts")
    .option("--retailer <id>", "active retailer ID or all", "all")
    .option("--purpose <purpose>", "discovery, extraction, or all", "all")
    .option("--database <path>", "authoritative SQLite database", "data/precos.sqlite")
    .option("--configs <directory>", "retailer configuration directory", "retailers")
    .option("--output-directory <directory>", "validation receipt directory", "data/validation")
    .option("--pacing-ms <milliseconds>", "fixed validation request pacing")
    .option("--timeout-ms <milliseconds>", "per-request timeout", String(DEFAULT_HTTP_TIMEOUT_MS))
    .option("--max-body-bytes <bytes>", "maximum captured response bytes", String(DEFAULT_MAX_BODY_BYTES))
    .option(
      "--signing-private-key <path>",
      "mode-0600 host Ed25519 validation signing key",
      "var/operations/validation-attestation-private.pem",
    )
    .option("--update-config", "atomically bind completed receipt metadata into configs")
    .option(
      "--prepare-discovery-challenge",
      "stage each inactive discovery candidate and refresh 120 bounded catalog references before validation",
    )
    .option("--activate", "activate only after binding every selected config receipt");
  command.parse(process.argv);
  const options = command.opts<CliOptions>();
  if (!(["all", "discovery", "extraction"] as const).includes(options.purpose)) {
    throw new Error("--purpose must be discovery, extraction, or all");
  }
  const timeoutMs = positiveInteger("--timeout-ms", options.timeoutMs);
  const maxBodyBytes = positiveInteger("--max-body-bytes", options.maxBodyBytes);
  const pacingMs = options.pacingMs === undefined
    ? undefined
    : positiveInteger("--pacing-ms", options.pacingMs);
  const signingPrivateKey = readValidationSigningPrivateKey(
    resolve(options.signingPrivateKey),
  );
  const configs = loadRetailerConfigs(resolve(options.configs))
    .filter((config) => config.active)
    .filter((config) => options.retailer === "all" || config.id === options.retailer);
  if (configs.length === 0) {
    throw new Error(`No active retailer matches ${options.retailer}`);
  }
  const purposes: Purpose[] = options.purpose === "all"
    ? ["discovery", "extraction"]
    : [options.purpose];
  if (options.activate === true && options.updateConfig !== true) {
    throw new Error("--activate requires --update-config");
  }
  const databasePath = resolve(options.database);
  const configsDirectory = resolve(options.configs);
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (options.prepareDiscoveryChallenge === true && purposes.includes("discovery")) {
      for (const config of configs) {
        const challenge = authoritativeRefs(database, config.id);
        if (challenge.length !== SAMPLE_SIZE) {
          throw new Error(
            `${config.id} has ${challenge.length}/${SAMPLE_SIZE} independent challenge references`,
          );
        }
        process.stdout.write(`${JSON.stringify({
          event: "discovery-challenge-prepared",
          retailerId: config.id,
          source: "preexisting-active-in-scope-catalog",
          attempted: challenge.length,
          catalogPreserved: true,
        })}\n`);
      }
    }
    const completed = await executeValidationRollout({
      configs,
      purposes,
      configsDirectory,
      databasePath,
      updateConfig: options.updateConfig === true,
      activate: options.activate === true,
      validation: {
        database,
        outputDirectory: resolve(options.outputDirectory),
        signingPrivateKey,
        ...(pacingMs === undefined ? {} : { pacingMs }),
        timeoutMs,
        maxBodyBytes,
      },
    });
    for (const { config, purpose, result } of completed) {
      const sampleDurationMs = result.evidence.samples.reduce(
        (total, sample) => total + sample.durationMs,
        0,
      );
      process.stdout.write(`${JSON.stringify({
        path: result.path,
        retailerId: config.id,
        purpose,
        attempted: result.evidence.attempted,
        valid: result.evidence.valid,
        score: result.evidence.score,
        activatable: result.evidence.activatable,
        validatedAt: result.evidence.validatedAt,
        sampleDurationMs,
        maximumSampleDurationMs: Math.max(
          ...result.evidence.samples.map((sample) => sample.durationMs),
        ),
        sampleSetSha256: result.evidence.sampleSetSha256,
        configPatch: {
          validatedAt: result.evidence.validatedAt,
          sampleSize: result.evidence.attempted,
          successes: result.evidence.valid,
          score: result.evidence.score,
          receiptSha256: validationReceiptSha256(result.evidence),
        },
      })}\n`);
    }
  } finally {
    database.close();
  }
}

function invokedAsMain(invokedPath: string | undefined): boolean {
  if (invokedPath === undefined) return false;
  try {
    return realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
