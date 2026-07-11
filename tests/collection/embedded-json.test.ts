import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { executeExtraction } from "../../src/collection/executor.js";
import type { FetchLike } from "../../src/collection/http.js";
import { EmbeddedJsonExtractionStrategySchema } from "../../src/strategies/schema.js";
import type { ProductRef } from "../../src/strategies/types.js";

const productRef: ProductRef = {
  canonicalUrl: "https://shop.test/product/embedded",
  externalId: "embedded",
  sourceCategory: "mercearia",
};

async function htmlFixture(): Promise<string> {
  return readFile(
    new URL("../fixtures/generic/embedded-product.html", import.meta.url),
    "utf8",
  );
}

async function fixtureFetch(): Promise<Response> {
  return new Response(await htmlFixture(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function strategy(source: unknown, fields: Record<string, string>) {
  return EmbeddedJsonExtractionStrategySchema.parse({
    schemaVersion: 1,
    purpose: "extraction",
    tier: "embedded-json",
    allowedDomains: ["shop.test"],
    request: { method: "GET", url: "{productUrl}", headers: {} },
    source,
    fields,
  });
}

describe("embedded JSON extraction", () => {
  it("finds a Product inside JSON-LD arrays and @graph containers", async () => {
    const extractionStrategy = strategy(
      { kind: "json-ld" },
      {
        title: "$.name",
        brand: "$.brand.name",
        price: "$.offers.highPrice",
        promoPrice: "$.offers.price",
        unit: "$.size",
        availability: "$.offers.availability",
      },
    );

    const result = await executeExtraction(extractionStrategy, productRef, {
      fetch: fixtureFetch,
    });

    expect(result).toEqual({
      ok: true,
      fields: {
        title: "Feijão Carioca",
        brand: "Marca Boa",
        price: 9.99,
        promoPrice: 8.49,
        unit: "Pacote 1 kg",
        available: true,
      },
    });
    expect(result.replay).toEqual(expect.objectContaining({
      body: expect.stringContaining("Fixture offline"),
      mediaType: "text/html",
    }));
    expect(Object.keys(result)).not.toContain("replay");
  });

  it("extracts the __NEXT_DATA__ document", async () => {
    const prefix = "$.props.pageProps.product";
    const extractionStrategy = strategy(
      { kind: "next-data" },
      {
        title: `${prefix}.name`,
        brand: `${prefix}.brand`,
        price: `${prefix}.price`,
        promoPrice: `${prefix}.promoPrice`,
        unit: `${prefix}.unit`,
        availability: `${prefix}.available`,
      },
    );

    const result = await executeExtraction(extractionStrategy, productRef, {
      fetch: fixtureFetch,
    });

    expect(result).toMatchObject({
      ok: true,
      fields: {
        title: "Café Torrado",
        brand: "Marca Next",
        price: 21.9,
        promoPrice: null,
        unit: "500 g",
        available: true,
      },
    });
  });

  it("uses Cheerio only to locate a configured JSON script", async () => {
    const extractionStrategy = strategy(
      { kind: "script", selector: "script#custom-state" },
      {
        title: "$.product.name",
        brand: "$.product.brand",
        price: "$.product.price",
        promoPrice: "$.product.promoPrice",
        unit: "$.product.unit",
        availability: "$.product.available",
      },
    );

    const result = await executeExtraction(extractionStrategy, productRef, {
      fetch: fixtureFetch,
    });

    expect(result).toMatchObject({
      ok: true,
      fields: {
        title: "Leite Integral",
        brand: "Marca State",
        price: 6.39,
        promoPrice: 5.99,
        unit: "1 l",
        available: true,
      },
    });
  });

  it("returns a categorized failure when the configured script is absent", async () => {
    const extractionStrategy = strategy(
      { kind: "script", selector: "script#missing" },
      {
        title: "$.name",
        brand: "$.brand",
        price: "$.price",
        promoPrice: "$.promoPrice",
        unit: "$.unit",
        availability: "$.available",
      },
    );
    const fetch: FetchLike = fixtureFetch;

    const result = await executeExtraction(extractionStrategy, productRef, { fetch });

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "parse", responded: true },
    });
  });

  it("rejects over-deep JSON-LD graphs with a categorized failure", async () => {
    let nested = JSON.stringify({
      "@type": "Product",
      name: "Deep Product",
      brand: "Brand",
      price: 10,
      promo: 9,
      unit: "1 kg",
      available: true,
    });
    for (let depth = 0; depth < 200; depth += 1) {
      nested = `{"@graph":[${nested}]}`;
    }
    const extractionStrategy = strategy(
      { kind: "json-ld" },
      {
        title: "$.name",
        brand: "$.brand",
        price: "$.price",
        promoPrice: "$.promo",
        unit: "$.unit",
        availability: "$.available",
      },
    );

    await expect(executeExtraction(extractionStrategy, productRef, {
      fetch: async () => new Response(
        `<script type="application/ld+json">${nested}</script>`,
        { headers: { "content-type": "text/html" } },
      ),
    })).resolves.toMatchObject({
      ok: false,
      failure: { category: "parse", responded: true },
    });
  });

  it("rejects a graph wider than the node budget before enqueueing children", async () => {
    const nodes = Array.from({ length: 10_001 }, () => "{}").join(",");
    const extractionStrategy = strategy(
      { kind: "json-ld" },
      {
        title: "$.name",
        brand: "$.brand",
        price: "$.price",
        promoPrice: "$.promo",
        unit: "$.unit",
        availability: "$.available",
      },
    );

    const result = await executeExtraction(extractionStrategy, productRef, {
      fetch: async () => new Response(
        `<script type="application/ld+json">{"@graph":[${nodes}]}</script>`,
        { headers: { "content-type": "text/html" } },
      ),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "parse",
        message: expect.stringMatching(/before enqueue/iu),
      },
    });
  });
});
