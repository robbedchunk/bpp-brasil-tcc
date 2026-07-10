import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
      "extra-mercado",
      "pao-de-acucar",
    ]);
    for (const config of configs.filter(({ active }) => active)) {
      expect(config.validation).toMatchObject({
        externallyValidated: true,
        sampleSize: 30,
        successes: 30,
        score: 1,
      });
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

  it("registers retailers and immutable versioned strategies idempotently", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const configs = loadRetailerConfigs("retailers");

    registerRetailerConfigs(database, configs);
    registerRetailerConfigs(database, configs);

    expect(database.prepare("SELECT COUNT(*) AS n FROM retailers").get()).toEqual({ n: 5 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM strategies").get()).toEqual({ n: 10 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM strategies WHERE active = 1").get()).toEqual({ n: 4 });
    expect(database.prepare("SELECT id FROM retailers WHERE active = 1 ORDER BY id").all()).toEqual([
      { id: "extra-mercado" },
      { id: "pao-de-acucar" },
    ]);
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
});
