#!/usr/bin/env node

import { createHash, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { Command } from "commander";
import { chromium, type Browser } from "playwright";

import { executeExtraction } from "../src/collection/executor.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_HTTP_TIMEOUT_MS,
  fetchBounded,
  type FetchLike,
} from "../src/collection/http.js";
import { executeDiscovery } from "../src/discovery/executor.js";
import { openDatabase } from "../src/db/database.js";
import { runDiscovery } from "../src/pipeline/discover.js";
import { DiscoveryFailureError } from "../src/discovery/failure.js";
import { RobotsPolicy } from "../src/discovery/robots.js";
import { redact } from "../src/ops/logger.js";
import {
  loadRetailerConfigs,
  registerRetailerConfigs,
  stageRetailerConfigStrategy,
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
import { extractionValidationFailureReason } from "../src/strategies/validate.js";
import {
  attestStrategyValidationEvidence,
  canonicalEvidenceJson,
  evidenceValueSha256,
  readValidationSigningPrivateKey,
  strategyEvidenceSha256,
  validateStrategyEvidence,
  validationReceiptSha256,
  validationRefSha256,
  validationSampleSetSha256,
  type StrategyValidationEvidence,
} from "../src/strategies/validation-evidence.js";

const SAMPLE_SIZE = 30;
const MINIMUM_PACING_MS = 500;
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
  discoveryChallengeRunId?: string;
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

function clockNow(dependencies: ValidationRunDependencies): number {
  return dependencies.clock?.() ?? performance.now();
}

function executorIdentity(dependencies: ValidationRunDependencies): {
  mode: "trusted-live-host" | "test";
  runtime: string;
  sourceCommit: string;
  playwrightVersion: string;
  chromiumVersion: string;
} {
  const injected = dependencies.fetch !== undefined
    || dependencies.browser !== undefined
    || dependencies.now !== undefined
    || dependencies.sleep !== undefined
    || dependencies.clock !== undefined
    || dependencies.runtime !== undefined;
  if (injected) {
    return {
      mode: "test",
      runtime: dependencies.runtime ?? `node-v${process.versions.node}`,
      sourceCommit: "f".repeat(40),
      playwrightVersion: "test",
      chromiumVersion: "test",
    };
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "scripts",
      "src",
      "retailers",
      "package.json",
      "package-lock.json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim();
  if (dirty !== "") {
    throw new Error("Trusted validation requires a clean committed implementation tree");
  }
  const require = createRequire(import.meta.url);
  const playwrightPackage = require("playwright/package.json") as { version?: unknown };
  if (typeof playwrightPackage.version !== "string") {
    throw new Error("Playwright version could not be resolved");
  }
  return {
    mode: "trusted-live-host",
    runtime: `node-v${process.versions.node}`,
    sourceCommit,
    playwrightVersion: playwrightPackage.version,
    chromiumVersion: execFileSync(chromium.executablePath(), ["--version"], {
      encoding: "utf8",
    }).trim(),
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
  discoveryChallengeRunId?: string,
): ProductRef[] {
  if (discoveryChallengeRunId !== undefined) {
    return (database.prepare(
      `WITH challenge AS (
         SELECT canonical_url, MIN(day_ordinal) AS ordinal
         FROM discovery_reference_admissions
         WHERE run_id = ? AND canonical_url IS NOT NULL
         GROUP BY canonical_url
       )
       SELECT product.canonical_url, product.retailer_product_id,
              product.source_category
       FROM challenge
       JOIN products AS product
         ON product.retailer_id = ?
        AND product.canonical_url = challenge.canonical_url
       WHERE product.active = 1 AND product.in_scope = 1
       ORDER BY challenge.ordinal, product.canonical_url`,
    ).all(discoveryChallengeRunId, retailerId) as Array<{
      canonical_url: string;
      retailer_product_id: string | null;
      source_category: string | null;
    }>).map((row) => ({
      canonicalUrl: row.canonical_url,
      externalId: row.retailer_product_id,
      sourceCategory: row.source_category,
    }));
  }
  return (database.prepare(
    `SELECT canonical_url, retailer_product_id, source_category
     FROM products
     WHERE retailer_id = ? AND active = 1 AND in_scope = 1
     GROUP BY canonical_url
     ORDER BY last_seen DESC, canonical_url`,
  ).all(retailerId) as Array<{
    canonical_url: string;
    retailer_product_id: string | null;
    source_category: string | null;
  }>).map((row) => ({
    canonicalUrl: row.canonical_url,
    externalId: row.retailer_product_id,
    sourceCategory: row.source_category,
  }));
}

function refKey(ref: ProductRef): string {
  return canonicalEvidenceJson({
    canonicalUrl: ref.canonicalUrl,
    externalId: ref.externalId,
    sourceCategory: ref.sourceCategory,
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
    totalTimeoutMs: timeoutMs,
    maxBodyBytes,
    beforeRequest: () => recorder.pace(),
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
    await iterator.return?.();
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

export async function validateConfiguredStrategy(
  config: RetailerConfig,
  purpose: Purpose,
  dependencies: ValidationRunDependencies,
): Promise<ValidationRunResult> {
  if (!config.active) throw new Error(`Retailer ${config.id} is not active`);
  if (dependencies.discoveryChallengeRunId !== undefined) {
    if (purpose !== "discovery") {
      throw new Error("A discovery challenge run cannot select extraction references");
    }
    const challengeRun = dependencies.database.prepare(
      `SELECT retailer_id AS retailerId, stage, strategy_id AS strategyId,
              status, finished_at AS finishedAt
       FROM runs WHERE id = ?`,
    ).get(dependencies.discoveryChallengeRunId) as {
      retailerId: string;
      stage: string;
      strategyId: string | null;
      status: string;
      finishedAt: string | null;
    } | undefined;
    const expectedStrategyId = `${config.id}-discovery-v${config.strategyVersions.discovery}`;
    if (
      challengeRun === undefined
      || challengeRun.retailerId !== config.id
      || challengeRun.stage !== "discover"
      || challengeRun.strategyId !== expectedStrategyId
      || challengeRun.status === "running"
      || challengeRun.finishedAt === null
    ) {
      throw new Error("Discovery validation requires a terminal matching candidate preflight run");
    }
  }
  const refs = authoritativeRefs(
    dependencies.database,
    config.id,
    dependencies.discoveryChallengeRunId,
  );
  if (refs.length < SAMPLE_SIZE) {
    throw new Error(
      `${config.id} has ${refs.length}/${SAMPLE_SIZE} authoritative in-scope product references`,
    );
  }
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const pacingMs = Math.max(
    MINIMUM_PACING_MS,
    dependencies.pacingMs ?? config.politeDelayMs.min,
  );
  const identity = executorIdentity(dependencies);
  const now = dependencies.now ?? (() => new Date());
  const executionStartedAt = now();
  const monotonicStartedAt = clockNow(dependencies);
  const recorder = new ExchangeRecorder({
    fetch: dependencies.fetch,
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
    verificationPublicKey: createPublicKey(dependencies.signingPrivateKey),
    authoritativeRefs: refs,
  });
  const path = resolve(
    dependencies.outputDirectory,
    `${config.id}-${purpose}-v${config.strategyVersions[purpose]}.json`,
  );
  await writeCanonicalAtomic(path, evidence);
  return { path, evidence };
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
  const discoveryChallengeRuns = new Map<string, string>();
  if (options.prepareDiscoveryChallenge === true && purposes.includes("discovery")) {
    const writable = openDatabase(databasePath);
    try {
      for (const config of configs) {
        const staged = stageRetailerConfigStrategy(writable, config, "discovery");
        const summary = await runDiscovery(config.id, {
          database: writable,
          strategyOverride: {
            ...staged,
            purpose: "discovery",
            strategy: config.discovery,
          },
          preserveCatalog: true,
          limit: 120,
          politeDelayMs: config.politeDelayMs,
          logDirectory: resolve("var/log/precos"),
        });
        if (summary.ok < SAMPLE_SIZE || summary.inScope < SAMPLE_SIZE) {
          throw new Error(
            `${config.id} candidate preflight produced ${summary.ok} references, `
            + `${summary.inScope} in scope; ${SAMPLE_SIZE} are required`,
          );
        }
        discoveryChallengeRuns.set(config.id, summary.id);
        process.stdout.write(`${JSON.stringify({
          event: "discovery-challenge-prepared",
          retailerId: config.id,
          strategyId: staged.id,
          runId: summary.id,
          attempted: summary.attempted,
          ok: summary.ok,
          inScope: summary.inScope,
          snapshotComplete: summary.snapshotComplete,
          catalogPreserved: true,
        })}\n`);
      }
    } finally {
      writable.close();
    }
  }
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const completed: Array<{
    config: RetailerConfig;
    purpose: Purpose;
    result: ValidationRunResult;
  }> = [];
  try {
    for (const config of configs) {
      for (const purpose of purposes) {
        const result = await validateConfiguredStrategy(config, purpose, {
          database,
          outputDirectory: resolve(options.outputDirectory),
          signingPrivateKey,
          ...(purpose === "discovery" && discoveryChallengeRuns.has(config.id)
            ? { discoveryChallengeRunId: discoveryChallengeRuns.get(config.id) }
            : {}),
          ...(pacingMs === undefined ? {} : { pacingMs }),
          timeoutMs,
          maxBodyBytes,
        });
        completed.push({ config, purpose, result });
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
    }
  } finally {
    database.close();
  }
  if (
    options.updateConfig === true
    && completed.some(({ result }) => result.evidence.activatable !== true)
  ) {
    throw new Error(
      "Refusing to bind non-activatable validation evidence; create a successor strategy version",
    );
  }
  if (options.updateConfig === true) {
    for (const config of configs) {
      const validation = { ...config.validation };
      for (const item of completed.filter((candidate) => candidate.config.id === config.id)) {
        validation[item.purpose] = {
          ...validation[item.purpose],
          externallyValidated: true,
          validatedAt: item.result.evidence.validatedAt,
          sampleSize: item.result.evidence.attempted,
          successes: item.result.evidence.valid,
          score: item.result.evidence.score,
          receiptSha256: validationReceiptSha256(item.result.evidence),
        };
      }
      await writeConfigAtomic(join(configsDirectory, `${config.id}.json`), {
        ...config,
        validation,
      });
    }
  }
  if (options.activate === true) {
    const writable = openDatabase(databasePath);
    try {
      const selectedRetailers = new Set(configs.map(({ id }) => id));
      registerRetailerConfigs(
        writable,
        loadRetailerConfigs(configsDirectory)
          .filter(({ id }) => selectedRetailers.has(id)),
        {
          projectRoot: dirname(configsDirectory),
          verificationPublicKey: createPublicKey(signingPrivateKey),
        },
      );
    } finally {
      writable.close();
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
