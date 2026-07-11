import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeExtraction } from "../../src/collection/executor.js";
import { openDatabase } from "../../src/db/database.js";
import {
  loadRetailerConfigs,
  registerRetailerConfigs,
  validateFixtureStrategy,
} from "../../src/retailers/config.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

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
      expect(config.politeDelayMs.min).toBeGreaterThanOrEqual(500);
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

  it("binds St Marché price and availability to the covered public store", async () => {
    const config = loadRetailerConfigs("retailers")
      .find(({ id }) => id === "st-marche");
    expect(config?.storeMapping).toMatchObject({ storeId: "66677604431" });
    expect(config?.extraction.tier).toBe("api");
    if (config === undefined || config.extraction.tier !== "api") return;
    expect(config.extraction.request.query).toMatchObject({
      store_id: "66677604431",
      _data: "routes/collections.$collection.products.$handle",
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
    const provenance = database.prepare(
      `SELECT purpose, provenance FROM strategies
       WHERE retailer_id = 'pao-de-acucar' ORDER BY purpose`,
    ).all() as Array<{ purpose: string; provenance: string }>;
    expect(provenance.find(({ purpose }) => purpose === "discovery")?.provenance)
      .toMatch(/official store-61 response/i);
    expect(provenance.find(({ purpose }) => purpose === "extraction")?.provenance)
      .toMatch(/bestPrices/i);
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
      { version: 2, active: 1, retired: 0 },
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
