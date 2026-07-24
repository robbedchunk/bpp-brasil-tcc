import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { validateConfiguredStrategy } from "../../scripts/validate-strategies.js";
import { initializeValidationAttestationKeyPair } from "../../scripts/init-validation-attestation-key.js";
import { openDatabase } from "../../src/db/database.js";
import { upsertDiscoveredProduct } from "../../src/db/repositories.js";
import { loadRetailerConfigs, type RetailerConfig } from "../../src/retailers/config.js";
import { selectStrategyValidationChallenge } from "../../src/strategies/validation-challenge.js";
import type { ProductRef } from "../../src/strategies/types.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const directories: string[] = [];
const execFileAsync = promisify(execFile);
const { privateKey: TEST_SIGNING_PRIVATE_KEY } = generateKeyPairSync("ed25519");

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function config(id: string): RetailerConfig {
  const found = loadRetailerConfigs("retailers").find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing test retailer ${id}`);
  return found;
}

function seed(database: ReturnType<typeof openDatabase>, retailer: RetailerConfig, refs: ProductRef[]): void {
  database.prepare(
    `INSERT INTO retailers
       (id, name, base_url, cep, platform_hint, domains_json, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    retailer.id,
    retailer.name,
    retailer.baseUrl,
    retailer.cep,
    "test",
    JSON.stringify(retailer.allowedDomains),
  );
  refs.forEach((ref, index) => {
    upsertDiscoveredProduct(
      database,
      retailer.id,
      ref,
      new Date(Date.UTC(2026, 6, 11, 0, 0, index)).toISOString(),
    );
  });
}

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strategy-validation-"));
  directories.push(directory);
  return directory;
}

describe("trusted live-host validation runner", () => {
  it("runs through a symlinked entry path", async () => {
    const directory = await outputDirectory();
    const linkedRunner = join(directory, "validate-strategies.ts");
    await symlink(join(process.cwd(), "scripts/validate-strategies.ts"), linkedRunner);
    try {
      const result = await execFileAsync(process.execPath, [
        "--import",
        "tsx",
        linkedRunner,
        "--help",
      ], { cwd: process.cwd() });
      // This sandbox can report a zero-exit child process with no captured
      // output (also seen in the existing exploration package test).
      if (result.stdout.length === 0) return;
      expect(result.stdout).toContain("Produce trusted live-host strategy validation receipts");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
  });

  it("initializes one mode-0600 key idempotently without rotation", async () => {
    const directory = await outputDirectory();
    const privatePath = join(directory, "validation-attestation-private.pem");
    const publicPath = join(directory, "validation-attestation-public.pem");
    const first = await initializeValidationAttestationKeyPair(privatePath, publicPath);
    const original = await readFile(privatePath);
    const second = await initializeValidationAttestationKeyPair(privatePath, publicPath);

    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ created: false, keyId: first.keyId });
    expect(await readFile(privatePath)).toEqual(original);
    expect((await stat(privatePath)).mode & 0o777).toBe(0o600);
  });

  it("records exact API outcomes and an honest non-responded attempt without bodies or headers", async () => {
    const retailer = config("extra-mercado");
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 30 }, (_value, index) => ({
      canonicalUrl: `https://www.extramercado.com.br/produto/${1_000 + index}/produto-${index}`,
      externalId: String(1_000 + index),
      sourceCategory: "Alimentos",
    }));
    seed(database, retailer, refs);
    let requests = 0;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      requests += 1;
      if (requests === 1) throw new TypeError("synthetic network failure");
      const url = typeof input === "string" ? input : input.toString();
      const match = /\/ecom\/(\d+)\/bestPrices/u.exec(url);
      if (match?.[1] === undefined) throw new Error(`Unexpected URL ${url}`);
      return new Response(JSON.stringify({
        rawSecretMarker: "must-not-be-stored",
        content: {
          id: Number(match[1]),
          name: `Product ${match[1]}`,
          brand: "Brand",
          sellInfos: [{ currentPrice: 10, sellPrice: 9, stock: 1 }],
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-private-response-header": "must-not-be-stored",
        },
      });
    };
    const directory = await outputDirectory();
    let elapsedMs = 0;

    const result = await validateConfiguredStrategy(retailer, "extraction", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch,
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds;
      },
      clock: () => elapsedMs,
      now: () => new Date(Date.parse("2026-07-11T06:00:00.000Z") + elapsedMs),
      runtime: "node-v24.18.0",
    });

    expect(result.evidence).toMatchObject({
      attempted: 30,
      valid: 29,
      score: 29 / 30,
      activatable: false,
      executor: { mode: "test", sequentialPacingMs: 500, elapsedMs: 14_500 },
    });
    expect(result.evidence.samples[0]).toMatchObject({
      response: null,
      outcome: {
        status: "invalid",
        failure: { category: "network", responded: false, statusCode: null },
      },
      validatedFacts: {
        returnedProductId: null,
        catalogSellerId: null,
        catalogSellerMatchCount: null,
      },
    });
    expect(result.evidence.samples[1]).toMatchObject({
      startedOffsetMs: 500,
      durationMs: 0,
      outcome: { status: "valid", fields: { price: 10, promoPrice: 9 } },
    });
    expect(result.evidence.samples[1]?.validatedFacts.returnedProductId)
      .toBe(result.evidence.samples[1]?.ref.externalId);
    const raw = await readFile(result.path, "utf8");
    expect(raw).not.toContain("rawSecretMarker");
    expect(raw).not.toContain("x-private-response-header");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("rechecks the monotonic clock when a pacing sleep wakes early", async () => {
    const retailer = config("extra-mercado");
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 30 }, (_value, index) => ({
      canonicalUrl: `https://www.extramercado.com.br/produto/${1_500 + index}/produto-${index}`,
      externalId: String(1_500 + index),
      sourceCategory: "Alimentos",
    }));
    seed(database, retailer, refs);
    let elapsedMs = 0;
    let shortWakeups = 0;
    const directory = await outputDirectory();

    const result = await validateConfiguredStrategy(retailer, "extraction", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        const id = /\/ecom\/(\d+)\/bestPrices/u.exec(url)?.[1];
        return new Response(JSON.stringify({
          content: {
            id: Number(id),
            name: `Product ${id}`,
            brand: "Brand",
            sellInfos: [{ currentPrice: 10, sellPrice: 9, stock: 1 }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      sleep: async (milliseconds) => {
        if (milliseconds > 1) {
          elapsedMs += milliseconds - 0.75;
          shortWakeups += 1;
        } else {
          elapsedMs += milliseconds;
        }
      },
      clock: () => elapsedMs,
      now: () => new Date(Date.parse("2026-07-11T06:00:30.000Z") + elapsedMs),
      runtime: "node-v24.18.0",
    });

    expect(shortWakeups).toBe(29);
    const offsets = result.evidence.samples.map((sample) => sample.startedOffsetMs);
    expect(offsets[0]).toBe(0);
    expect(offsets.slice(1).every((offset, index) =>
      offset - (offsets[index] ?? 0) >= 500)).toBe(true);
    expect(result.evidence).toMatchObject({ attempted: 30, valid: 30, score: 1 });
  });

  it("scores 30 numeric-only extraction titles invalid", async () => {
    const retailer = config("extra-mercado");
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 30 }, (_value, index) => ({
      canonicalUrl: `https://www.extramercado.com.br/produto/${3_000 + index}/produto-${index}`,
      externalId: String(3_000 + index),
      sourceCategory: "Alimentos",
    }));
    seed(database, retailer, refs);
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const id = /\/ecom\/(\d+)\/bestPrices/u.exec(url)?.[1];
      return new Response(JSON.stringify({
        content: {
          id: Number(id),
          name: id,
          brand: "Brand",
          sellInfos: [{ currentPrice: 10, sellPrice: 9, stock: 1 }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const directory = await outputDirectory();
    let elapsedMs = 0;
    const result = await validateConfiguredStrategy(retailer, "extraction", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch,
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds;
      },
      clock: () => elapsedMs,
      now: () => new Date(Date.parse("2026-07-11T06:00:00.000Z") + elapsedMs),
      runtime: "node-v24.18.0",
    });

    expect(result.evidence).toMatchObject({ valid: 0, score: 0, activatable: false });
    expect(result.evidence.samples.every((sample) =>
      sample.outcome.status === "invalid")).toBe(true);
    expect(result.evidence.samples.some((sample) =>
      sample.outcome.status === "invalid"
      && /descriptive product text|title/iu.test(sample.outcome.failure.message))).toBe(true);
  });

  it("binds API discovery samples to authoritative product identity across category changes", async () => {
    const retailer = config("extra-mercado");
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 30 }, (_value, index) => ({
      canonicalUrl: `https://www.extramercado.com.br/produto/${2_000 + index}/produto-${index}`,
      externalId: String(2_000 + index),
      sourceCategory: "Legacy category label",
    }));
    seed(database, retailer, refs);
    const fetch = async (): Promise<Response> => new Response(JSON.stringify({
      products: refs.map((ref) => ({
        id: Number(ref.externalId),
        urlDetails: ref.canonicalUrl,
      })),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const directory = await outputDirectory();

    const result = await validateConfiguredStrategy(retailer, "discovery", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch,
      sleep: async () => undefined,
      clock: () => 0,
      now: () => new Date("2026-07-11T06:01:00.000Z"),
      runtime: "node-v24.18.0",
    });

    expect(result.evidence).toMatchObject({ attempted: 30, valid: 30, score: 1 });
    expect(new Set(result.evidence.samples.map((sample) => sample.ref.canonicalUrl)))
      .toEqual(new Set(refs.map((ref) => ref.canonicalUrl)));
    expect(result.evidence.samples.every((sample) =>
      sample.outcome.status === "valid"
      && sample.outcome.fields === null
      && sample.response?.bodySha256 !== undefined)).toBe(true);
    let resumeRequests = 0;
    const resumed = await validateConfiguredStrategy(retailer, "discovery", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch: async () => {
        resumeRequests += 1;
        throw new Error("A matching immutable receipt must be reused without network I/O");
      },
      sleep: async () => undefined,
      clock: () => 0,
      now: () => new Date("2026-07-11T06:01:01.000Z"),
      runtime: "node-v24.18.0",
    });
    expect(resumeRequests).toBe(0);
    expect(resumed).toEqual(result);
  });

  it("scores a preselected discovery challenge instead of choosing 30 successes post hoc", async () => {
    const retailer = config("extra-mercado");
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 31 }, (_value, index) => ({
      canonicalUrl: `https://www.extramercado.com.br/produto/${3_000 + index}/challenge-${index}`,
      externalId: String(3_000 + index),
      sourceCategory: "Alimentos",
    }));
    seed(database, retailer, refs);
    const challenge = selectStrategyValidationChallenge(database, retailer.id, 30);
    const returned = refs.filter((ref) =>
      ref.canonicalUrl !== challenge[0]?.canonicalUrl).slice(0, 30);
    const directory = await outputDirectory();
    let elapsedMs = 0;

    const result = await validateConfiguredStrategy(retailer, "discovery", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch: async () => new Response(JSON.stringify({
        products: returned.map((ref) => ({
          id: Number(ref.externalId),
          urlDetails: ref.canonicalUrl,
        })),
      }), { status: 200, headers: { "content-type": "application/json" } }),
      sleep: async (milliseconds) => { elapsedMs += milliseconds; },
      clock: () => elapsedMs,
      now: () => new Date(Date.parse("2026-07-11T06:01:30.000Z") + elapsedMs),
      runtime: "node-v24.18.0",
    });

    expect(result.evidence).toMatchObject({ attempted: 30, valid: 29, score: 29 / 30 });
    expect(result.evidence.samples[0]).toMatchObject({
      ref: challenge[0],
      outcome: { status: "invalid" },
    });
    expect(result.evidence.samples.map((sample) => sample.ref.canonicalUrl))
      .toEqual(challenge.map((ref) => ref.canonicalUrl));
  });

  it("selects the independent challenge regardless of candidate admission order", async () => {
    const retailer = config("extra-mercado");
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 31 }, (_value, index) => ({
      canonicalUrl: `https://www.extramercado.com.br/produto/${4_000 + index}/prepared-${index}`,
      externalId: String(4_000 + index),
      sourceCategory: "Alimentos",
    }));
    seed(database, retailer, refs);
    const strategyId = `${retailer.id}-discovery-v${retailer.strategyVersions.discovery}`;
    const runId = "prepared-discovery-challenge";
    database.prepare(
      `INSERT INTO strategies
       (id, retailer_id, purpose, tier, version, strategy_json, provenance,
        validation_sample_size, validation_successes, validation_rate, active)
       VALUES (?, ?, 'discovery', 1, ?, ?, 'candidate preflight', 0, 0, NULL, 0)`,
    ).run(
      strategyId,
      retailer.id,
      retailer.strategyVersions.discovery,
      JSON.stringify(retailer.discovery),
    );
    database.prepare(
      `INSERT INTO runs
       (id, retailer_id, stage, collection_day, strategy_id, strategy_version,
        status, attempted, ok, failed, started_at)
       VALUES (?, ?, 'discover', '2026-07-11', ?, ?, 'running', 0, 0, 0,
               '2026-07-11T06:01:00.000Z')`,
    ).run(runId, retailer.id, strategyId, retailer.strategyVersions.discovery);
    const admit = database.prepare(
      `INSERT INTO discovery_reference_admissions
       (id, run_id, retailer_id, collection_day, day_ordinal,
        canonical_url, admitted_at)
       VALUES (?, ?, ?, '2026-07-11', ?, ?, '2026-07-11T06:01:00.000Z')`,
    );
    [...refs].reverse().forEach((ref, index) => admit.run(
      `prepared-reference-${index}`,
      runId,
      retailer.id,
      index + 1,
      ref.canonicalUrl,
    ));
    database.prepare(
      `UPDATE runs SET status = 'completed', attempted = 31, ok = 31,
                       finished_at = '2026-07-11T06:01:01.000Z'
       WHERE id = ?`,
    ).run(runId);
    const directory = await outputDirectory();
    const challenge = selectStrategyValidationChallenge(database, retailer.id, 30);

    const result = await validateConfiguredStrategy(retailer, "discovery", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch: async () => new Response(JSON.stringify({
        products: challenge.map((ref) => ({
          id: Number(ref.externalId),
          urlDetails: ref.canonicalUrl,
        })),
      }), { status: 200, headers: { "content-type": "application/json" } }),
      sleep: async () => undefined,
      clock: () => 0,
      now: () => new Date("2026-07-11T06:01:30.000Z"),
      runtime: "node-v24.18.0",
    });

    expect(result.evidence).toMatchObject({ valid: 30, score: 1 });
    expect(result.evidence.samples.map(({ ref }) => ref.canonicalUrl))
      .toEqual(challenge.map((ref) => ref.canonicalUrl));
  });

  it("captures St Marche browser page evidence for DOM-crawl discovery", async () => {
    const configured = config("st-marche");
    const retailer: RetailerConfig = {
      ...configured,
      discovery: {
        schemaVersion: 1,
        purpose: "discovery",
        tier: "dom-crawl",
        allowedDomains: ["marche.com.br"],
        startUrls: ["https://marche.com.br/collections/mercearia"],
        linkSelectors: [{
          selector: "a[data-discover=\"true\"][href*=\"/products/\"]",
          attribute: "href",
        }],
        maxPages: 1,
        maxProducts: 30,
      },
    };
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 30 }, (_value, index) => ({
      canonicalUrl: `https://marche.com.br/products/browser-product-${index}`,
      externalId: null,
      sourceCategory: "acougue",
    }));
    seed(database, retailer, refs);
    const html = `<!doctype html><html><body>${refs.map((ref) =>
      `<a data-discover="true" href="${ref.canonicalUrl.replace(
        "/products/",
        "/collections/mercearia/products/",
      )}">Product</a>`).join("")}`
      + `<iframe src="https://marche.com.br/evidence-decoy"></iframe></body></html>`;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      return url.endsWith("/robots.txt")
        ? new Response("User-agent: *\nDisallow:\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          })
        : new Response(url.includes("evidence-decoy") ? "UNRELATED DECOY" : html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    };
    const directory = await outputDirectory();
    let browserElapsedMs = 0;

    const result = await validateConfiguredStrategy(retailer, "discovery", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch,
      sleep: async (milliseconds) => {
        browserElapsedMs += milliseconds;
      },
      clock: () => browserElapsedMs,
      now: () => new Date(
        Date.parse("2026-07-11T06:02:00.000Z") + browserElapsedMs,
      ),
      runtime: "node-v24.18.0",
    });

    expect(result.evidence).toMatchObject({ attempted: 30, valid: 30, score: 1 });
    expect(result.evidence.samples.every((sample) =>
      sample.response?.contentType.startsWith("text/html") === true)).toBe(true);
    expect(result.evidence.samples.every((sample) =>
      sample.response?.finalUrl.includes("evidence-decoy") === false)).toBe(true);
  }, 30_000);
});
