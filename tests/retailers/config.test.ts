import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { decideFoodAtHomeScope } from "../../src/catalog/scope.js";
import { executeExtraction } from "../../src/collection/executor.js";
import { openDatabase } from "../../src/db/database.js";
import { upsertDiscoveredProduct } from "../../src/db/repositories.js";
import { classifyRunHealth } from "../../src/healing/classify-failure.js";
import {
  loadRetailerConfigs,
  registerRetailerConfigs as registerRetailerConfigsWithEvidence,
  stageRetailerConfigStrategy,
  type RetailerConfig,
  validateFixtureStrategy,
} from "../../src/retailers/config.js";
import {
  attestStrategyValidationEvidence,
  evidenceValueSha256,
  strategyEvidenceSha256,
  validationRefSha256,
  validationReceiptSha256,
  validationSampleSetSha256,
} from "../../src/strategies/validation-evidence.js";

const {
  privateKey: TEST_SIGNING_PRIVATE_KEY,
  publicKey: TEST_VERIFICATION_PUBLIC_KEY,
} = generateKeyPairSync("ed25519");
const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function testReceipt(config: RetailerConfig, purpose: "discovery" | "extraction") {
  const strategy = config[purpose];
  const validation = config.validation[purpose];
  const sellerId = purpose === "extraction" && strategy.tier === "api"
    ? strategy.regionalContext?.catalogSellerId ?? null
    : null;
  const samples = Array.from({ length: 30 }, (_value, index) => {
    const externalId = `validation-${index}`;
    const ref = {
      canonicalUrl: `https://${strategy.allowedDomains[0]}/validation/${index}`,
      externalId,
      sourceCategory: "Mercearia",
    };
    const request = {
      method: "GET" as const,
      url: ref.canonicalUrl,
      bodySha256: null,
    };
    const valid = index < validation.successes;
    const outcome = valid
      ? purpose === "extraction"
        ? {
            status: "valid" as const,
            fields: {
              title: `Product ${index}`,
              brand: "Brand",
              price: 10,
              promoPrice: 9,
              unit: "1 kg",
              available: true,
            },
          }
        : { status: "valid" as const, fields: null }
      : {
          status: "invalid" as const,
          failure: {
            category: "invalid-price" as const,
            message: "No positive price",
            responded: true,
            statusCode: 200,
          },
        };
    return {
      ordinal: index + 1,
      startedOffsetMs: index * 500,
      durationMs: 100 + index,
      ref,
      refSha256: validationRefSha256(ref),
      request,
      requestSha256: evidenceValueSha256(request),
      response: {
        finalUrl: request.url,
        statusCode: 200,
        contentType: "application/json",
        bodyBytes: 100 + index,
        bodySha256: evidenceValueSha256({ response: purpose, index }),
      },
      outcome,
      outcomeSha256: evidenceValueSha256(outcome),
      validatedFacts: {
        returnedProductId: externalId,
        catalogSellerId: sellerId,
        catalogSellerMatchCount: sellerId === null ? null : 1,
      },
    };
  });
  const elapsedMs = 29 * 500 + 129;
  const finishedAt = validation.validatedAt ?? "2026-07-11T06:00:00.000Z";
  const startedAt = new Date(Date.parse(finishedAt) - elapsedMs).toISOString();
  return attestStrategyValidationEvidence({
    schemaVersion: 2,
    retailerId: config.id,
    purpose,
    strategyVersion: config.strategyVersions[purpose],
    strategySha256: strategyEvidenceSha256(strategy),
    validatedAt: validation.validatedAt,
    executor: {
      program: "scripts/validate-strategies.ts",
      version: 1,
      mode: "trusted-live-host",
      runtime: "node-v24.18.0",
      sourceCommit: "a".repeat(40),
      playwrightVersion: "1.61.1",
      chromiumVersion: "Chromium 141.0.0.0",
      artifactSha256: "d".repeat(64),
      challengeAlgorithm: "active-in-scope-category-url-bucket-round-robin-v1",
      sequentialPacingMs: 500,
      timeoutMs: 15_000,
      maxBodyBytes: 2_000_000,
      startedAt,
      finishedAt,
      elapsedMs,
      requestHeadersStored: false,
      responseBodiesStored: false,
    },
    attempted: 30,
    valid: validation.successes,
    score: validation.score,
    activatable: true,
    sampleSetSha256: validationSampleSetSha256(samples),
    samples,
  }, TEST_SIGNING_PRIVATE_KEY);
}

function registerRetailerConfigs(
  database: ReturnType<typeof openDatabase>,
  configs: readonly RetailerConfig[],
): void {
  const bundle = testActivationBundle(configs);
  registerRetailerConfigsWithEvidence(database, bundle.configs, {
    testVerificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
    readValidationReceipt: (absolutePath) => {
      for (const [path, receipt] of bundle.receipts) {
        if (absolutePath.endsWith(path)) return receipt;
      }
      throw new Error(`Unexpected validation receipt ${absolutePath}`);
    },
  });
}

function testActivationBundle(configs: readonly RetailerConfig[]): {
  configs: RetailerConfig[];
  receipts: Map<string, ReturnType<typeof testReceipt>>;
} {
  const receipts = new Map<string, ReturnType<typeof testReceipt>>();
  const boundConfigs = configs.map((config) => {
    if (!config.active) return config;
    const validation = { ...config.validation };
    for (const purpose of ["discovery", "extraction"] as const) {
      const receipt = testReceipt(config, purpose);
      const path = `data/validation/${config.id}-${purpose}-v${config.strategyVersions[purpose]}.json`;
      receipts.set(path, receipt);
      validation[purpose] = {
        ...validation[purpose],
        receiptPath: path,
        receiptSha256: validationReceiptSha256(receipt),
      };
    }
    return { ...config, validation };
  });
  return { configs: boundConfigs, receipts };
}

function receiptReader(receipts: Map<string, ReturnType<typeof testReceipt>>) {
  return (absolutePath: string): unknown => {
    for (const [path, receipt] of receipts) {
      if (absolutePath.endsWith(path)) return receipt;
    }
    throw new Error(`Unexpected validation receipt ${absolutePath}`);
  };
}

describe("live retailer configuration", () => {
  it("loads the five named retailers with closed strategies and CEP evidence", () => {
    const configs = loadRetailerConfigs("retailers");

    expect(configs.map(({ id }) => id)).toEqual([
      "carrefour",
      "extra-mercado",
      "pao-de-acucar",
      "sonda",
      "st-marche",
    ]);
    for (const config of configs) {
      expect(config.allowedDomains.length).toBeGreaterThan(0);
      expect(config.cep).toMatch(/^\d{5}-\d{3}$/u);
      expect(config.discovery.purpose).toBe("discovery");
      expect(config.extraction.purpose).toBe("extraction");
      expect(config.politeDelayMs.min).toBeGreaterThanOrEqual(200);
      expect(config.politeDelayMs.max).toBeGreaterThanOrEqual(config.politeDelayMs.min);
      expect(config.fixtureProvenance.length).toBeGreaterThanOrEqual(2);
      expect(config.strategyVersions.discovery).toBeGreaterThan(0);
      expect(config.strategyVersions.extraction).toBeGreaterThan(0);
    }
  });

  it("activates only externally validated 30-sample primaries", () => {
    const configs = loadRetailerConfigs("retailers");
    expect(configs.filter(({ active }) => active).map(({ id }) => id)).toEqual([
      "carrefour",
      "extra-mercado",
      "pao-de-acucar",
      "st-marche",
    ]);
    for (const config of configs.filter(({ active }) => active)) {
      for (const purpose of ["discovery", "extraction"] as const) {
        const validation = config.validation[purpose];
        expect(validation.externallyValidated).toBe(true);
        expect(validation.sampleSize).toBe(30);
        expect(validation.successes).toBeGreaterThanOrEqual(27);
        expect(validation.score).toBeGreaterThanOrEqual(0.9);
      }
    }
    expect(configs.find(({ id }) => id === "sonda")).toMatchObject({
      active: false,
      backupRank: 1,
    });
  });

  it("declares broad food-at-home discovery instead of narrow search defaults", () => {
    const active = loadRetailerConfigs("retailers").filter(({ active }) => active);
    for (const config of active) {
      expect(config.discovery.maxProducts).toBeGreaterThanOrEqual(1_500);
      expect(config.discovery.maxProducts).toBeLessThanOrEqual(3_000);
      const serialized = JSON.stringify(config.discovery);
      expect(serialized).not.toMatch(/"ft":"cafe"|"terms":"arroz"/iu);
      if (config.discovery.tier === "api") {
        expect(config.discovery.segments?.length).toBeGreaterThan(0);
        const allocation = config.discovery.segments?.reduce(
          (sum, segment) => sum + segment.maxProducts,
          0,
        ) ?? 0;
        expect(allocation).toBe(config.discovery.maxProducts);
        expect(
          config.discovery.refFields.sourceCategory !== undefined
          || config.discovery.segments?.every(({ sourceCategory }) =>
            sourceCategory !== undefined),
        ).toBe(true);
      } else if (config.discovery.tier === "dom-crawl") {
        expect(config.discovery.startUrls.length).toBeGreaterThanOrEqual(10);
        expect(config.discovery.paginationSelectors).toBeDefined();
      }
    }
  });

  it("keeps the four-retailer worst-case daily start-spacing budget under one hour", () => {
    const active = loadRetailerConfigs("retailers").filter(({ active }) => active);
    const dailyPageCap = 2_000;
    const worstCaseSpacingMs = active.reduce(
      (total, config) => total + ((dailyPageCap - 1) * config.politeDelayMs.max),
      0,
    );
    expect(worstCaseSpacingMs).toBeLessThan(60 * 60 * 1_000);
  });

  it("keeps every configured St Marche collection inside food-at-home scope", () => {
    const config = loadRetailerConfigs("retailers").find(({ id }) => id === "st-marche");
    expect(config?.discovery.tier).toBe("dom-crawl");
    if (config?.discovery.tier !== "dom-crawl") return;
    for (const startUrl of config.discovery.startUrls) {
      const slug = new URL(startUrl).pathname.split("/").filter(Boolean).at(-1)!;
      expect(decideFoodAtHomeScope({
        canonicalUrl: `https://marche.com.br/collections/${slug}/products/fixture`,
        externalId: null,
        sourceCategory: slug.replaceAll("-", " "),
      })).toMatchObject({ inScope: true });
    }
  });

  it("validates sanitized saved fixtures without network access", async () => {
    const extractionByRetailer = new Map<string, boolean>();
    for (const config of loadRetailerConfigs("retailers")) {
      const report = await validateFixtureStrategy(config);
      expect(report).toMatchObject({ activatable: true });
      extractionByRetailer.set(config.id, report.extractionOk);
      for (const fixture of config.fixtureProvenance) {
        const body = await readFile(resolve(fixture.path), "utf8");
        expect(body).not.toMatch(/set-cookie|authorization|session[_-]?id|bearer\s|01310-100/iu);
        if (fixture.synthetic) expect(body).toMatch(/synthetic/iu);
      }
    }
    expect(extractionByRetailer).toEqual(new Map([
      ["carrefour", true],
      ["extra-mercado", true],
      ["pao-de-acucar", true],
      ["sonda", false],
      ["st-marche", true],
    ]));
  });

  it("classifies every retailer mutation as extraction drift", async () => {
    const covered = new Set<string>();
    for (const config of loadRetailerConfigs("retailers")) {
      const mutations = config.fixtureProvenance.filter(({ synthetic }) => synthetic);
      expect(mutations, `${config.id} must bind exactly one mutation fixture`).toHaveLength(1);
      const mutation = mutations[0]!;
      const body = await readFile(resolve(mutation.path), "utf8");
      const result = await executeExtraction(config.extraction, config.fixtureRef, {
        fetch: async () => new Response(body, {
          status: 200,
          headers: {
            "content-type": mutation.path.endsWith(".html")
              ? "text/html; charset=utf-8"
              : "application/json",
          },
        }),
      });

      expect(result.ok, `${config.id} mutation must break its current extraction strategy`)
        .toBe(false);
      expect(result.failure, `${config.id} mutation must retain categorized failure evidence`)
        .toMatchObject({ responded: true });
      const failure = result.failure!;
      expect(classifyRunHealth(
        { attempted: 30, ok: 0, failed: 30, status: "failed" },
        Array.from({ length: 30 }, () => ({
          category: failure.category,
          responded: failure.responded,
        })),
      ), `${config.id} mutation must reach the automatic-healing drift path`).toBe("drift");
      covered.add(config.id);
    }
    expect(covered).toEqual(new Set([
      "carrefour",
      "extra-mercado",
      "pao-de-acucar",
      "sonda",
      "st-marche",
    ]));
  });

  it("binds St Marché price and availability to the covered public store", async () => {
    const config = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "st-marche");
    expect(config?.storeMapping).toMatchObject({ storeId: "66677604431" });
    expect(config?.extraction.tier).toBe("api");
    if (config === undefined || config.extraction.tier !== "api") return;
    expect(config.extraction.request.query).toMatchObject({
      store_id: "66677604431",
      _data: "routes/products.$handle",
    });
    expect(config.extraction.fields.availability).toBe("$.hasInventory");
    const body = await readFile(
      resolve("tests/fixtures/st-marche/store-product.json"),
      "utf8",
    );

    const result = await executeExtraction(config.extraction, config.fixtureRef, {
      fetch: async () => new Response(body),
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        title: "Arroz Longo Fino Camil Tipo 1 1Kg",
        brand: "Camil",
        price: 5.49,
        promoPrice: 3.99,
        unit: "Arroz Longo Fino Camil Tipo 1 1Kg",
        available: true,
      },
    });
  });

  it("binds Carrefour's regional offer to the validated catalog seller", async () => {
    const config = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "carrefour");
    expect(config?.extraction.tier).toBe("api");
    if (config === undefined || config.extraction.tier !== "api") return;
    expect(config.extraction.regionalContext).toMatchObject({
      regionId: "v2.F8ECD79715AD7D06EB43E6255163CF3A",
      catalogSellerId: "1",
    });
    const [regional, plain, mutated] = await Promise.all([
      readFile(resolve("tests/fixtures/carrefour/catalog-product.json"), "utf8"),
      readFile(resolve("tests/fixtures/carrefour/catalog-product-plain.json"), "utf8"),
      readFile(resolve("tests/fixtures/carrefour/mutated-product.json"), "utf8"),
    ]);
    const extract = (body: string) => executeExtraction(
      config.extraction,
      config.fixtureRef,
      { fetch: async () => new Response(body) },
    );

    const [regionalResult, plainResult, mutatedResult] = await Promise.all([
      extract(regional),
      extract(plain),
      extract(mutated),
    ]);

    expect(regionalResult).toMatchObject({ ok: true, fields: { price: 104.99 } });
    expect(plainResult).toMatchObject({ ok: true, fields: { price: 53.99 } });
    expect(mutatedResult).toMatchObject({
      ok: false,
      failure: {
        category: "missing-fields",
        message: expect.stringMatching(/seller|exactly once/iu),
        responded: true,
      },
    });
  });

  it("registers retailers and immutable versioned strategies idempotently", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const configs = loadRetailerConfigs("retailers");

    registerRetailerConfigs(database, configs);
    registerRetailerConfigs(database, configs);

    expect(database.prepare("SELECT COUNT(*) AS n FROM retailers").get()).toEqual({ n: 5 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM strategies").get()).toEqual({ n: 10 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM strategies WHERE active = 1").get()).toEqual({ n: 8 });
    expect(database.prepare("SELECT id FROM retailers WHERE active = 1 ORDER BY id").all()).toEqual([
      { id: "carrefour" },
      { id: "extra-mercado" },
      { id: "pao-de-acucar" },
      { id: "st-marche" },
    ]);
    expect(database.prepare(
      `SELECT retailer_id AS retailerId, tier
       FROM strategies
       WHERE purpose = 'discovery' AND active = 1
       ORDER BY retailer_id`,
    ).all()).toEqual([
      { retailerId: "carrefour", tier: 2 },
      { retailerId: "extra-mercado", tier: 2 },
      { retailerId: "pao-de-acucar", tier: 2 },
      { retailerId: "st-marche", tier: 3 },
    ]);
    const provenance = database.prepare(
      `SELECT purpose, provenance FROM strategies
       WHERE retailer_id = 'pao-de-acucar' ORDER BY purpose`,
    ).all() as Array<{ purpose: string; provenance: string }>;
    expect(provenance.find(({ purpose }) => purpose === "discovery")?.provenance)
      .toMatch(/pinned trusted-live-host successor validation/i);
    expect(provenance.find(({ purpose }) => purpose === "extraction")?.provenance)
      .toMatch(/pinned trusted-live-host successor validation/i);
  });

  it("stages an immutable inactive successor without changing live activation", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "extra-mercado");
    expect(current).toBeDefined();
    if (current === undefined) return;
    registerRetailerConfigs(database, [current]);
    const successorVersion = current.strategyVersions.discovery + 1;
    const successor: RetailerConfig = {
      ...current,
      strategyVersions: {
        ...current.strategyVersions,
        discovery: successorVersion,
      },
      validation: {
        ...current.validation,
        discovery: {
          ...current.validation.discovery,
          receiptPath: `data/validation/${current.id}-discovery-v${successorVersion}.json`,
          receiptSha256: null,
        },
      },
    };

    const first = stageRetailerConfigStrategy(database, successor, "discovery");
    const second = stageRetailerConfigStrategy(database, successor, "discovery");

    expect(second).toEqual(first);
    expect(database.prepare(
      `SELECT id, active, retired_at AS retiredAt
       FROM strategies WHERE retailer_id = ? AND purpose = 'discovery'
       ORDER BY version`,
    ).all(current.id)).toEqual([
      {
        id: `${current.id}-discovery-v${current.strategyVersions.discovery}`,
        active: 1,
        retiredAt: null,
      },
      {
        id: `${current.id}-discovery-v${successorVersion}`,
        active: 0,
        retiredAt: null,
      },
    ]);
    expect(database.prepare("SELECT active FROM retailers WHERE id = ?").get(current.id))
      .toEqual({ active: 1 });

    registerRetailerConfigs(database, [successor]);
    expect(database.prepare(
      `SELECT version, active, validation_sample_size AS sampleSize
       FROM strategies WHERE retailer_id = ? AND purpose = 'discovery'
       ORDER BY version`,
    ).all(current.id)).toEqual([
      { version: current.strategyVersions.discovery, active: 0, sampleSize: 30 },
      { version: successorVersion, active: 1, sampleSize: 30 },
    ]);
  });

  it("rejects activation when the receipt aggregate differs from config metadata", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "extra-mercado");
    expect(current).toBeDefined();
    if (current === undefined) return;
    const discoveryReceipt = testReceipt(current, "discovery");
    const extractionReceipt = testReceipt(current, "extraction");
    const mismatchedSuccesses = current.validation.extraction.successes - 1;
    const changed = {
      ...current,
      validation: {
        ...current.validation,
        extraction: {
          ...current.validation.extraction,
          successes: mismatchedSuccesses,
          score: mismatchedSuccesses / 30,
          receiptSha256: validationReceiptSha256(extractionReceipt),
        },
        discovery: {
          ...current.validation.discovery,
          receiptSha256: validationReceiptSha256(discoveryReceipt),
        },
      },
    };

    expect(() => registerRetailerConfigsWithEvidence(database, [changed], {
      testVerificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      readValidationReceipt: (path) => path.includes("-extraction-")
        ? extractionReceipt
        : discoveryReceipt,
    })).toThrow(/aggregate/iu);
    expect(database.prepare("SELECT COUNT(*) AS n FROM retailers").get())
      .toEqual({ n: 0 });
  });

  it("uses the tracked key and forbids supplied keys for file-backed activation", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "extra-mercado");
    expect(current).toBeDefined();
    if (current === undefined) return;
    const bundle = testActivationBundle([current]);
    const readValidationReceipt = receiptReader(bundle.receipts);
    const temporary = mkdtempSync(join(tmpdir(), "validation-key-test-"));
    try {
      expect(() => registerRetailerConfigsWithEvidence(database, bundle.configs, {
        readValidationReceipt,
      })).toThrow(/attestation/iu);
      expect(() => registerRetailerConfigsWithEvidence(database, bundle.configs, {
        testVerificationPublicKey: generateKeyPairSync("ed25519").publicKey,
        readValidationReceipt,
      })).toThrow(/attestation/iu);
      const fileDatabase = openDatabase(join(temporary, "file-backed.sqlite"));
      try {
        expect(() => registerRetailerConfigsWithEvidence(fileDatabase, bundle.configs, {
          testVerificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
          readValidationReceipt,
        })).toThrow(/caller-supplied.*forbidden/iu);
      } finally {
        fileDatabase.close();
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    expect(database.prepare("SELECT COUNT(*) AS n FROM retailers").get())
      .toEqual({ n: 0 });
  });

  it("rejects replacement of immutable receipt evidence for an activated version", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "extra-mercado");
    expect(current).toBeDefined();
    if (current === undefined) return;
    const bundle = testActivationBundle([current]);
    registerRetailerConfigsWithEvidence(database, bundle.configs, {
      testVerificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      readValidationReceipt: receiptReader(bundle.receipts),
    });
    const path = current.validation.extraction.receiptPath;
    if (path === null) throw new Error("Missing extraction receipt path");
    const original = bundle.receipts.get(path);
    if (original === undefined) throw new Error("Missing extraction receipt");
    const first = original.samples[0]!;
    const samples = [{ ...first, durationMs: first.durationMs + 1 }, ...original.samples.slice(1)];
    const { attestation: _attestation, ...payload } = original;
    const replacement = attestStrategyValidationEvidence({
      ...payload,
      samples,
      sampleSetSha256: validationSampleSetSha256(samples),
    }, TEST_SIGNING_PRIVATE_KEY);
    const replacementConfig: RetailerConfig = {
      ...bundle.configs[0]!,
      validation: {
        ...bundle.configs[0]!.validation,
        extraction: {
          ...bundle.configs[0]!.validation.extraction,
          receiptSha256: validationReceiptSha256(replacement),
        },
      },
    };
    const replacements = new Map(bundle.receipts);
    replacements.set(path, replacement);

    expect(() => registerRetailerConfigsWithEvidence(database, [replacementConfig], {
      testVerificationPublicKey: TEST_VERIFICATION_PUBLIC_KEY,
      readValidationReceipt: receiptReader(replacements),
    })).toThrow(/immutable validation evidence|successor version/iu);
  });

  it("keeps a bound receipt re-registerable after mutable catalog fields change", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "extra-mercado");
    expect(current).toBeDefined();
    if (current === undefined) return;
    registerRetailerConfigs(database, [current]);
    const receipt = testReceipt(current, "discovery");
    for (const sample of receipt.samples) {
      upsertDiscoveredProduct(
        database,
        current.id,
        sample.ref,
        "2026-07-11T06:00:00.000Z",
      );
    }
    database.prepare(
      `UPDATE products
       SET active = 0, in_scope = 0, source_category = 'Categoria atualizada'
       WHERE retailer_id = ? AND canonical_url = ?`,
    ).run(current.id, receipt.samples[0]?.ref.canonicalUrl);

    expect(() => registerRetailerConfigs(database, [current])).not.toThrow();
  });

  it("retires a previous active strategy when a validated append-only version is registered", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "pao-de-acucar");
    expect(current).toBeDefined();
    if (current === undefined) return;
    const previous = {
      ...current,
      strategyVersions: { ...current.strategyVersions, extraction: 1 },
    };

    registerRetailerConfigs(database, [previous]);
    registerRetailerConfigs(database, [current]);

    expect(database.prepare(
      `SELECT version, active, retired_at IS NOT NULL AS retired
       FROM strategies WHERE retailer_id = 'pao-de-acucar' AND purpose = 'extraction'
       ORDER BY version`,
    ).all()).toEqual([
      { version: 1, active: 0, retired: 1 },
      { version: current.strategyVersions.extraction, active: 1, retired: 0 },
    ]);
  });

  it("fails closed when immutable strategy JSON changes without a version bump", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "pao-de-acucar");
    expect(current).toBeDefined();
    if (current === undefined || current.extraction.tier !== "api") return;
    registerRetailerConfigs(database, [current]);
    const changed = {
      ...current,
      extraction: {
        ...current.extraction,
        request: {
          ...current.extraction.request,
          headers: { ...current.extraction.request.headers, "x-drift": "changed" },
        },
      },
    };

    expect(() => registerRetailerConfigs(database, [changed])).toThrow(/version bump/i);
    expect(database.prepare(
      "SELECT COUNT(*) AS n FROM strategies WHERE retailer_id = 'pao-de-acucar' AND active = 1",
    ).get()).toEqual({ n: 2 });
  });

  it("deactivates every strategy version when a retailer is made inactive", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "extra-mercado");
    expect(current).toBeDefined();
    if (current === undefined) return;
    registerRetailerConfigs(database, [current]);

    registerRetailerConfigs(database, [{ ...current, active: false }]);

    expect(database.prepare(
      "SELECT COUNT(*) AS n FROM strategies WHERE retailer_id = 'extra-mercado' AND active = 1",
    ).get()).toEqual({ n: 0 });
  });

  it("requires a successor version instead of reactivating a retired strategy", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const current = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "pao-de-acucar");
    expect(current).toBeDefined();
    if (current === undefined) return;
    registerRetailerConfigs(database, [current]);
    registerRetailerConfigs(database, [{ ...current, active: false }]);

    expect(() => registerRetailerConfigs(database, [current]))
      .toThrow(/retired.*version/i);
  });
});
