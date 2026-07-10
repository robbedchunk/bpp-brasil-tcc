import { readFile } from "node:fs/promises";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeDom } from "../../src/collection/dom.js";
import { DomExtractionStrategySchema } from "../../src/strategies/schema.js";
import {
  startLocalHttpServer,
  type LocalHttpServer,
} from "../helpers/local-http-server.js";

describe("executeDom", () => {
  let browser: Browser;
  let server: LocalHttpServer;

  beforeAll(async () => {
    const html = await readFile(
      new URL("../fixtures/generic/dom-product.html", import.meta.url),
      "utf8",
    );
    server = await startLocalHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    });
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("tries ordered selector fallbacks and maps text and attributes", async () => {
    const strategy = DomExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "dom",
      allowedDomains: ["127.0.0.1"],
      url: "{productUrl}",
      selectors: {
        title: [
          { selector: ".missing-title" },
          { selector: ".product-title" },
        ],
        brand: [{ selector: ".brand", attribute: "data-brand" }],
        price: [{ selector: ".regular-price" }],
        promoPrice: [{ selector: ".promotional-price" }],
        unit: [{ selector: ".unit" }],
        availability: [{ selector: ".stock", attribute: "data-available" }],
      },
    });

    const result = await executeDom(
      strategy,
      {
        canonicalUrl: `${server.origin}/produto/1`,
        externalId: "1",
        sourceCategory: "feijao",
      },
      { browser },
    );

    expect(result).toEqual({
      ok: true,
      fields: {
        title: "Feijão Carioca",
        brand: "Marca Boa",
        price: 19.9,
        promoPrice: 17.5,
        unit: "Pacote 1 kg",
        available: true,
      },
    });
  });

  it("rejects the initial navigation when its host is not allowlisted", async () => {
    const strategy = DomExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "dom",
      allowedDomains: ["shop.test"],
      url: "{productUrl}",
      selectors: {
        title: [{ selector: ".product-title" }],
        brand: [{ selector: ".brand" }],
        price: [{ selector: ".regular-price" }],
        promoPrice: [{ selector: ".promotional-price" }],
        unit: [{ selector: ".unit" }],
        availability: [{ selector: ".stock" }],
      },
    });

    await expect(
      executeDom(
        strategy,
        {
          canonicalUrl: `${server.origin}/produto/1`,
          externalId: "1",
          sourceCategory: null,
        },
        { browser },
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "domain-denied" },
    });
  });
});
