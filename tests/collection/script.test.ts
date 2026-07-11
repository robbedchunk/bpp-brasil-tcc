import { readFile } from "node:fs/promises";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeRestrictedScript } from "../../src/collection/script.js";
import { openDatabase } from "../../src/db/database.js";
import { runCollection } from "../../src/pipeline/collect.js";
import { ScriptStrategySchema } from "../../src/strategies/schema.js";
import { seedRetailer, seedStrategy } from "../pipeline/helpers.js";
import {
  startLocalHttpServer,
  type LocalHttpServer,
} from "../helpers/local-http-server.js";

describe("executeRestrictedScript", () => {
  let browser: Browser;
  let server: LocalHttpServer;

  beforeAll(async () => {
    const html = await readFile(
      new URL("../fixtures/generic/dom-product.html", import.meta.url),
      "utf8",
    );
    server = await startLocalHttpServer((request, response) => {
      if (request.url === "/navigation") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<a id="escape" href="about:blank">escape</a>`);
        return;
      }
      if (request.url === "/api/product%2F1") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          name: "Café Torrado",
          brand: "Marca Boa",
          price: 14.5,
          promo: 12.9,
          unit: "500 g",
          available: true,
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    });
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("interprets the closed browser operation set and extracts DOM fields", async () => {
    const strategy = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["127.0.0.1"],
      operations: [
        { op: "goto", url: "{productUrl}" },
        { op: "fill", selector: "#postal-code", value: "01310-100" },
        { op: "select", selector: "#store", value: "61" },
        { op: "click", selector: "#reveal" },
        {
          op: "waitFor",
          selector: ".product-card[data-revealed='true']",
          state: "attached",
        },
        { op: "scroll", deltaY: 400 },
        {
          op: "extract",
          source: "dom",
          selectors: {
            title: [{ selector: ".product-title" }],
            brand: [{ selector: ".brand", attribute: "data-brand" }],
            price: [{ selector: ".regular-price" }],
            promoPrice: [{ selector: ".promotional-price" }],
            unit: [{ selector: ".unit" }],
            availability: [{ selector: ".stock", attribute: "data-available" }],
          },
        },
      ],
    });

    const result = await executeRestrictedScript(
      strategy,
      {
        canonicalUrl: `${server.origin}/produto/1`,
        externalId: "1",
        sourceCategory: null,
      },
      { browser },
    );

    expect(result).toMatchObject({
      ok: true,
      fields: {
        title: "Feijão Carioca",
        price: 19.9,
        promoPrice: 17.5,
        available: true,
      },
    });
  });

  it("uses allowlisted HTTP operations as saved JSON extraction sources", async () => {
    const strategy = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["127.0.0.1"],
      operations: [
        {
          op: "http",
          request: {
            method: "GET",
            url: `${server.origin}/api/{externalId}`,
            headers: {},
          },
          saveAs: "product",
        },
        {
          op: "extract",
          source: "json",
          from: "product",
          fields: {
            title: "$.name",
            brand: "$.brand",
            price: "$.price",
            promoPrice: "$.promo",
            unit: "$.unit",
            availability: "$.available",
          },
        },
      ],
    });

    const result = await executeRestrictedScript(
      strategy,
      {
        canonicalUrl: `${server.origin}/produto/1`,
        externalId: "product/1",
        sourceCategory: null,
      },
      { browser },
    );

    expect(result).toMatchObject({
      ok: true,
      fields: { title: "Café Torrado", price: 14.5, promoPrice: 12.9 },
    });
  });

  it("durably admits and paces every tier-4 network operation", async () => {
    const database = openDatabase(":memory:");
    try {
      seedRetailer(database);
      const strategy = ScriptStrategySchema.parse({
        schemaVersion: 1,
        purpose: "extraction",
        tier: "script",
        allowedDomains: ["127.0.0.1"],
        operations: [
          {
            op: "http",
            request: {
              method: "GET",
              url: `${server.origin}/api/{externalId}`,
              headers: {},
            },
            saveAs: "first",
          },
          {
            op: "http",
            request: {
              method: "GET",
              url: `${server.origin}/api/{externalId}`,
              headers: {},
            },
            saveAs: "second",
          },
          {
            op: "extract",
            source: "json",
            from: "second",
            fields: {
              title: "$.name",
              brand: "$.brand",
              price: "$.price",
              promoPrice: "$.promo",
              unit: "$.unit",
              availability: "$.available",
            },
          },
        ],
      });
      seedStrategy(database, "extraction", strategy);
      database.prepare(`
        INSERT INTO products
          (id, retailer_id, canonical_url, retailer_product_id, title,
           descriptive_title, first_seen, last_seen)
        VALUES ('script-product', 'retailer-1', ?, 'product/1',
                'Café Torrado', 1,
                '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
      `).run(`${server.origin}/produto/1`);
      const sleeps: number[] = [];
      let clock = 1_000;

      const summary = await runCollection("retailer-1", {
        database,
        limit: 1,
        concurrency: 3,
        now: () => new Date("2026-07-10T12:00:00.000Z"),
        politeDelayMs: { min: 125, max: 125 },
        clock: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
      });

      expect(summary).toMatchObject({ attempted: 1, ok: 1, failed: 0 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count, MIN(stage_ordinal) AS first,
               MAX(stage_ordinal) AS last
        FROM request_admissions WHERE run_id = ?
      `).get(summary.id)).toEqual({ count: 2, first: 1, last: 2 });
      expect(sleeps).toEqual([125]);
    } finally {
      database.close();
    }
  });

  it("rejects every configured cross-domain browser or HTTP target", async () => {
    const ref = {
      canonicalUrl: `${server.origin}/produto/1`,
      externalId: "1",
      sourceCategory: null,
    };
    const gotoStrategy = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["shop.test"],
      operations: [
        { op: "goto", url: "{productUrl}" },
        {
          op: "extract",
          source: "dom",
          selectors: {
            title: [{ selector: "h1" }],
            brand: [{ selector: ".brand" }],
            price: [{ selector: ".price" }],
            promoPrice: [{ selector: ".promo" }],
            unit: [{ selector: ".unit" }],
            availability: [{ selector: ".availability" }],
          },
        },
      ],
    });
    const httpStrategy = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["shop.test"],
      operations: [
        {
          op: "http",
          request: { method: "GET", url: `${server.origin}/api/product/1`, headers: {} },
          saveAs: "product",
        },
        {
          op: "extract",
          source: "json",
          from: "product",
          fields: {
            title: "$.name",
            brand: "$.brand",
            price: "$.price",
            promoPrice: "$.promo",
            unit: "$.unit",
            availability: "$.available",
          },
        },
      ],
    });

    await expect(executeRestrictedScript(gotoStrategy, ref, { browser })).resolves.toMatchObject({
      ok: false,
      failure: { category: "domain-denied" },
    });
    await expect(executeRestrictedScript(httpStrategy, ref, { browser })).resolves.toMatchObject({
      ok: false,
      failure: { category: "domain-denied" },
    });
  });

  it("strictly rejects dynamic evaluation operations and executable material", () => {
    const base = {
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["shop.test"],
    } as const;

    expect(() => ScriptStrategySchema.parse({
      ...base,
      operations: [{ op: "evaluate", code: "process.env" }],
    })).toThrow();
    expect(() => ScriptStrategySchema.parse({
      ...base,
      operations: [{ op: "goto", url: "https://shop.test", code: "require('fs')" }],
    })).toThrow();
  });

  it("denies a non-HTTP navigation initiated by a click operation", async () => {
    const strategy = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["127.0.0.1"],
      operations: [
        { op: "goto", url: `${server.origin}/navigation` },
        { op: "click", selector: "#escape" },
        {
          op: "extract",
          source: "dom",
          timeoutMs: 1_000,
          selectors: {
            title: [{ selector: "h1" }],
            brand: [{ selector: ".brand" }],
            price: [{ selector: ".price" }],
            promoPrice: [{ selector: ".promo" }],
            unit: [{ selector: ".unit" }],
            availability: [{ selector: ".availability" }],
          },
        },
      ],
    });

    await expect(executeRestrictedScript(
      strategy,
      {
        canonicalUrl: `${server.origin}/produto/1`,
        externalId: "1",
        sourceCategory: null,
      },
      { browser },
    )).resolves.toMatchObject({
      ok: false,
      failure: { category: "domain-denied" },
    });
  });

  it("aborts and awaits an in-flight HTTP operation at the total deadline", async () => {
    const strategy = ScriptStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "script",
      allowedDomains: ["shop.test"],
      operations: [
        {
          op: "http",
          request: { method: "GET", url: "https://shop.test/pending", headers: {} },
          saveAs: "pending",
          timeoutMs: 2_000,
        },
        {
          op: "extract",
          source: "json",
          from: "pending",
          fields: {
            title: "$.name",
            brand: "$.brand",
            price: "$.price",
            promoPrice: "$.promo",
            unit: "$.unit",
            availability: "$.available",
          },
        },
      ],
    });
    let activeFetches = 0;
    let aborted = false;
    const startedAt = Date.now();

    const result = await executeRestrictedScript(
      strategy,
      {
        canonicalUrl: "https://shop.test/product/1",
        externalId: "1",
        sourceCategory: null,
      },
      {
        browser,
        totalTimeoutMs: 25,
        fetch: async (_input, init) => {
          activeFetches += 1;
          try {
            await new Promise<never>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(init.signal?.reason);
              }, { once: true });
            });
          } finally {
            activeFetches -= 1;
          }
          throw new Error("unreachable");
        },
      },
    );

    expect(result).toMatchObject({ ok: false, failure: { category: "timeout" } });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(activeFetches).toBe(0);
  });
});
