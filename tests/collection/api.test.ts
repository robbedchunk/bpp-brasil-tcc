import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { executeExtraction } from "../../src/collection/executor.js";
import {
  mapExtractionFields,
  mapJsonExtractionFields,
} from "../../src/collection/field-map.js";
import {
  DEFAULT_RESEARCH_USER_AGENT,
  fetchBounded,
  renderTemplateString,
  type FetchLike,
} from "../../src/collection/http.js";
import { ApiExtractionStrategySchema } from "../../src/strategies/schema.js";
import type { ProductRef } from "../../src/strategies/types.js";

const productRef: ProductRef = {
  canonicalUrl: "https://shop.test/p/1?campaign=fixture",
  externalId: "1/2",
  sourceCategory: "arroz e feijao",
};

const fields = {
  title: "$.data.product.name",
  brand: "$.data.product.manufacturer.name",
  price: "$.data.product.pricing.regular",
  promoPrice: "$.data.product.pricing.promotion",
  unit: "$.data.product.package",
  availability: "$.data.product.stock.available",
};

async function apiFixture(): Promise<string> {
  return readFile(
    new URL("../fixtures/generic/api-product.json", import.meta.url),
    "utf8",
  );
}

function fixtureResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

describe("API extraction", () => {
  it("renders a GET request and normalizes mapped fields", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch: FetchLike = async (input, init) => {
      seen.push({ url: String(input), init });
      return fixtureResponse(await apiFixture());
    };
    const strategy = ApiExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: {
        method: "GET",
        url: "https://shop.test/api/products/{externalId}",
        headers: { "x-product-id": "{externalId}" },
        query: {
          category: "{sourceCategory}",
          productUrl: "{productUrl}",
          active: true,
        },
      },
      fields,
    });

    const result = await executeExtraction(strategy, productRef, { fetch });

    expect(result).toEqual({
      ok: true,
      fields: {
        title: "Arroz Tipo 1",
        brand: "Marca",
        price: 12.99,
        promoPrice: 10.99,
        unit: "5 kg",
        available: true,
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      "https://shop.test/api/products/1%2F2?category=arroz+e+feijao&productUrl=https%3A%2F%2Fshop.test%2Fp%2F1%3Fcampaign%3Dfixture&active=true",
    );
    expect(seen[0]?.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new Headers(seen[0]?.init?.headers).get("x-product-id")).toBe("1/2");
    expect(new Headers(seen[0]?.init?.headers).get("user-agent")).toBe(
      DEFAULT_RESEARCH_USER_AGENT,
    );
  });

  it("derives a VTEX regional segment only in memory", async () => {
    let derivedPayload: Record<string, unknown> | null = null;
    const fetch: FetchLike = async (_input, init) => {
      const runtimeHeader = new Headers(init?.headers).get("cookie");
      expect(runtimeHeader).toMatch(/^vtex_segment=/u);
      const encoded = runtimeHeader?.slice("vtex_segment=".length) ?? "";
      derivedPayload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      return fixtureResponse(await apiFixture());
    };
    const strategy = ApiExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: {
        method: "GET",
        url: "https://shop.test/api/products/{externalId}",
        headers: { accept: "application/json" },
      },
      regionalContext: {
        kind: "vtex-segment",
        regionId: "v2.REGION_123",
        salesChannel: "2",
      },
      fields,
    });

    const result = await executeExtraction(strategy, productRef, { fetch });
    expect(result.ok).toBe(true);
    expect(derivedPayload).toMatchObject({
      channel: "2",
      regionId: "v2.REGION_123",
      campaigns: null,
      priceTables: null,
    });
    expect(JSON.stringify(strategy)).not.toMatch(/vtex_segment|cookie/iu);
  });

  it("does not forward a derived regional segment across origins", async () => {
    const seen: Array<{ url: string; cookie: string | null }> = [];
    const fetch: FetchLike = async (input, init) => {
      seen.push({
        url: String(input),
        cookie: new Headers(init?.headers).get("cookie"),
      });
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.test/products/1" },
        });
      }
      return fixtureResponse(await apiFixture());
    };
    const strategy = ApiExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test", "cdn.test"],
      request: {
        method: "GET",
        url: "https://shop.test/api/products/{externalId}",
        headers: { accept: "application/json" },
      },
      regionalContext: {
        kind: "vtex-segment",
        regionId: "v2.REGION_123",
        salesChannel: "2",
      },
      fields,
    });

    const result = await executeExtraction(strategy, productRef, { fetch });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      { url: "https://shop.test/api/products/1%2F2", cookie: expect.stringMatching(/^vtex_segment=/u) },
      { url: "https://cdn.test/products/1", cookie: null },
    ]);
  });

  it("selects the validated VTEX catalog seller by identity", async () => {
    const vtexFields = {
      title: "$[0].productName",
      brand: "$[0].brand",
      price: "$[0].items[0].sellers[0].commertialOffer.Price",
      promoPrice: "$[0].items[0].sellers[0].commertialOffer.PromotionPrice",
      unit: "$[0].items[0].measurementUnit",
      availability: "$[0].items[0].sellers[0].commertialOffer.IsAvailable",
    };
    const strategy = ApiExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: {
        method: "GET",
        url: "https://shop.test/api/products/{externalId}",
        headers: { accept: "application/json" },
      },
      regionalContext: {
        kind: "vtex-segment",
        regionId: "v2.REGION_123",
        salesChannel: "2",
        catalogSellerId: "expected-store",
      },
      fields: vtexFields,
    });
    const response = (
      sellers: unknown[],
      productId = productRef.externalId,
    ) => fixtureResponse(JSON.stringify([{
      productId,
      productName: "Café Regional 500g",
      brand: "Marca",
      items: [{ measurementUnit: "un", sellers }],
    }]));
    const other = {
      sellerId: "other-store",
      commertialOffer: { Price: 1, IsAvailable: true },
    };
    const expected = {
      sellerId: "expected-store",
      commertialOffer: { Price: 12.99, IsAvailable: true },
    };

    const selected = await executeExtraction(strategy, productRef, {
      fetch: async () => response([other, expected]),
    });
    const missing = await executeExtraction(strategy, productRef, {
      fetch: async () => response([other]),
    });
    const wrongProduct = await executeExtraction(strategy, productRef, {
      fetch: async () => response([expected], "WRONG-PRODUCT"),
    });
    const duplicateSeller = await executeExtraction(strategy, productRef, {
      fetch: async () => response([expected, { ...expected }]),
    });

    expect(selected).toMatchObject({
      ok: true,
      fields: { price: 12.99, available: true },
    });
    expect(missing).toMatchObject({
      ok: false,
      failure: {
        category: "missing-fields",
        responded: true,
        statusCode: 200,
      },
    });
    expect(wrongProduct).toMatchObject({
      ok: false,
      failure: {
        category: "missing-fields",
        message: expect.stringMatching(/product identity/iu),
      },
    });
    expect(duplicateSeller).toMatchObject({
      ok: false,
      failure: {
        category: "missing-fields",
        message: expect.stringMatching(/exactly once/iu),
      },
    });
  });

  it("renders nested POST body JSON templates without changing value types", async () => {
    let seenBody: unknown;
    let seenUrl = "";
    const fetch: FetchLike = async (input, init) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body));
      return fixtureResponse(await apiFixture());
    };
    const strategy = ApiExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: {
        method: "POST",
        url: "https://api.shop.test/lookup",
        headers: { accept: "application/json" },
        query: { market: "br" },
        body: {
          lookup: { id: "{externalId}", url: "{productUrl}" },
          metadata: [true, 3, null, "{sourceCategory}"],
        },
      },
      fields,
    });

    const result = await executeExtraction(strategy, productRef, { fetch });

    expect(result.ok).toBe(true);
    expect(seenUrl).toBe("https://api.shop.test/lookup?market=br");
    expect(seenBody).toEqual({
      lookup: { id: "1/2", url: productRef.canonicalUrl },
      metadata: [true, 3, null, "arroz e feijao"],
    });
  });

  it("rejects undocumented placeholders at the execution boundary", () => {
    expect(() => renderTemplateString("{processEnv}", productRef)).toThrow(
      /placeholder/iu,
    );
  });

  it("rejects an initial request outside the allowlist without calling fetch", async () => {
    let called = false;
    const result = await fetchBounded(
      { url: "https://evil.test/product", method: "GET" },
      ["shop.test"],
      {
        fetch: async () => {
          called = true;
          return fixtureResponse("{}");
        },
      },
    );

    expect(called).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "domain-denied", responded: false },
    });
  });

  it("rechecks each redirect target before following it", async () => {
    let calls = 0;
    const result = await fetchBounded(
      { url: "https://shop.test/start", method: "GET" },
      ["shop.test"],
      {
        fetch: async () => {
          calls += 1;
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.test/stolen" },
          });
        },
      },
    );

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "domain-denied", responded: true, statusCode: 302 },
    });
  });

  it("cancels response bodies on denied final URLs and malformed redirects", async () => {
    const cancellations: string[] = [];
    const body = (label: string) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("pending"));
      },
      cancel() {
        cancellations.push(label);
      },
    });
    const denied = new Response(body("denied"), { status: 200 });
    Object.defineProperty(denied, "url", { value: "https://evil.test/result" });

    const deniedResult = await fetchBounded(
      { url: "https://shop.test/start", method: "GET" },
      ["shop.test"],
      { fetch: async () => denied },
    );
    const malformedRedirect = await fetchBounded(
      { url: "https://shop.test/start", method: "GET" },
      ["shop.test"],
      { fetch: async () => new Response(body("redirect"), { status: 302 }) },
    );

    expect(deniedResult).toMatchObject({
      ok: false,
      failure: { category: "domain-denied" },
    });
    expect(malformedRedirect).toMatchObject({ ok: false });
    expect(cancellations).toEqual(["denied", "redirect"]);
  });

  it("categorizes malformed redirect locations instead of throwing", async () => {
    const result = await fetchBounded(
      { url: "https://shop.test/start", method: "GET" },
      ["shop.test"],
      {
        fetch: async () => new Response(null, {
          status: 302,
          headers: { location: "http://[" },
        }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "network", responded: true, statusCode: 302 },
    });
  });

  it("honors a zero redirect limit", async () => {
    let calls = 0;
    const result = await fetchBounded(
      { url: "https://shop.test/start", method: "GET" },
      ["shop.test"],
      {
        maxRedirects: 0,
        fetch: async () => {
          calls += 1;
          return new Response(null, {
            status: 302,
            headers: { location: "/next" },
          });
        },
      },
    );

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "network", responded: true, statusCode: 302 },
    });
  });

  it("validates a redirect target even when the redirect limit is zero", async () => {
    const result = await fetchBounded(
      { url: "https://shop.test/start", method: "GET" },
      ["shop.test"],
      {
        maxRedirects: 0,
        fetch: async () => new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/next" },
        }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "domain-denied", responded: true, statusCode: 302 },
    });
  });

  it("categorizes throttling as a responding page failure", async () => {
    const result = await fetchBounded(
      { url: "https://shop.test/product", method: "GET" },
      ["shop.test"],
      { fetch: async () => fixtureResponse("slow down", 429) },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "http-429", responded: true, statusCode: 429 },
    });
  });

  it("stops reading responses that exceed the configured byte bound", async () => {
    const result = await fetchBounded(
      { url: "https://shop.test/product", method: "GET" },
      ["shop.test"],
      {
        fetch: async () => fixtureResponse("0123456789"),
        maxBodyBytes: 5,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "parse", responded: true, statusCode: 200 },
    });
    if (!result.ok) expect(result.failure.message).toMatch(/large|bytes/iu);
  });

  it("returns the same bounded payload as raw bytes for binary consumers", async () => {
    const payload = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]);
    const result = await fetchBounded(
      { url: "https://shop.test/catalog.xml.gz", method: "GET" },
      ["shop.test"],
      { fetch: async () => new Response(payload) },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.response.bytes]).toEqual([...payload]);
  });

  it("categorizes response stream failures instead of throwing", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket closed"));
      },
    });
    const result = await fetchBounded(
      { url: "https://shop.test/product", method: "GET" },
      ["shop.test"],
      { fetch: async () => new Response(body, { status: 200 }) },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "network", responded: true, statusCode: 200 },
    });
  });

  it("categorizes AbortSignal timeouts without throwing", async () => {
    const fetch: FetchLike = async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
      throw new Error("unreachable");
    };

    const result = await fetchBounded(
      { url: "https://shop.test/product", method: "GET" },
      ["shop.test"],
      { fetch, timeoutMs: 1 },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "timeout", responded: false },
    });
  });

  it("rejects a promotional price above the regular price", async () => {
    const payload = JSON.stringify({
      data: {
        product: {
          name: "Arroz tipo 1 pacote",
          manufacturer: { name: "Marca" },
          pricing: { regular: 10, promotion: 11 },
          package: "1 kg",
          stock: { available: true },
        },
      },
    });
    const strategy = ApiExtractionStrategySchema.parse({
      schemaVersion: 1,
      purpose: "extraction",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: { method: "GET", url: "{productUrl}", headers: {} },
      fields,
    });

    const result = await executeExtraction(strategy, productRef, {
      fetch: async () => fixtureResponse(payload),
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "invalid-price", responded: true },
    });
  });

  it("maps storefront sale/list order to regular and promotional prices", () => {
    const result = mapJsonExtractionFields({
      title: "Arroz tipo 1 pacote",
      brand: "Marca",
      sale: 8,
      list: 10,
      available: true,
    }, {
      title: "$.title",
      brand: "$.brand",
      price: "$.sale",
      promoPrice: "$.list",
      priceOrder: "sale-list",
      unit: "$.unit",
      availability: "$.available",
    });

    expect(result).toMatchObject({
      ok: true,
      fields: { price: 10, promoPrice: 8 },
    });
  });

  it("normalizes Portuguese unavailable labels to a boolean", () => {
    expect(mapExtractionFields({
      title: "Arroz tipo 1 pacote",
      brand: null,
      price: "R$ 10,00",
      promoPrice: null,
      unit: null,
      availability: "Não disponível",
    })).toEqual({
      ok: true,
      fields: {
        title: "Arroz tipo 1 pacote",
        brand: null,
        price: 10,
        promoPrice: null,
        unit: null,
        available: false,
      },
    });
  });
});
