import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateConfiguredStrategy } from "../../scripts/validate-strategies.js";
import { initializeValidationAttestationKeyPair } from "../../scripts/init-validation-attestation-key.js";
import { openDatabase } from "../../src/db/database.js";
import { upsertDiscoveredProduct } from "../../src/db/repositories.js";
import { loadRetailerConfigs, type RetailerConfig } from "../../src/retailers/config.js";
import type { ProductRef } from "../../src/strategies/types.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const directories: string[] = [];
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

  it("binds API discovery samples to exact authoritative database references", async () => {
    const retailer = config("extra-mercado");
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 30 }, (_value, index) => ({
      canonicalUrl: `https://www.extramercado.com.br/produto/${2_000 + index}/produto-${index}`,
      externalId: String(2_000 + index),
      sourceCategory: "Alimentos",
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
    await expect(validateConfiguredStrategy(retailer, "discovery", {
      database,
      outputDirectory: directory,
      signingPrivateKey: TEST_SIGNING_PRIVATE_KEY,
      fetch,
      sleep: async () => undefined,
      clock: () => 0,
      now: () => new Date("2026-07-11T06:01:01.000Z"),
      runtime: "node-v24.18.0",
    })).rejects.toThrow(/already exists.*successor/iu);
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
    const challenge = (database.prepare(`
      SELECT canonical_url AS canonicalUrl, retailer_product_id AS externalId,
             source_category AS sourceCategory
      FROM products
      WHERE retailer_id = ? AND active = 1 AND in_scope = 1
      ORDER BY last_seen DESC, canonical_url
      LIMIT 30
    `).all(retailer.id) as typeof refs);
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

  it("captures St Marche browser page evidence for DOM-crawl discovery", async () => {
    const retailer = config("st-marche");
    const database = openDatabase(":memory:");
    databases.push(database);
    const refs = Array.from({ length: 30 }, (_value, index) => ({
      canonicalUrl: `https://marche.com.br/collections/mercearia/products/browser-product-${index}`,
      externalId: null,
      sourceCategory: "acougue",
    }));
    seed(database, retailer, refs);
    const html = `<!doctype html><html><body>${refs.map((ref) =>
      `<a data-discover="true" href="${ref.canonicalUrl}">Product</a>`).join("")}`
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
