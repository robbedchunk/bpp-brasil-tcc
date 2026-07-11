import { describe, expect, it } from "vitest";

import {
  ApiDiscoveryStrategySchema,
  ApiExtractionStrategySchema,
  DiscoveryStrategySchema,
  DomCrawlDiscoveryStrategySchema,
  DomExtractionStrategySchema,
  EmbeddedJsonExtractionStrategySchema,
  ExtractionStrategySchema,
  ScriptDiscoveryStrategySchema,
  ScriptStrategySchema,
  SitemapDiscoveryStrategySchema,
  parseStrategy,
} from "../../src/strategies/schema.js";

const extractionBase = {
  schemaVersion: 1,
  purpose: "extraction",
  allowedDomains: ["shop.test"],
} as const;

const discoveryBase = {
  schemaVersion: 1,
  purpose: "discovery",
  allowedDomains: ["shop.test"],
} as const;

const jsonFields = {
  title: "$.name",
  brand: "$.brand",
  price: "$.price",
  promoPrice: "$.promo",
  unit: "$.unit",
  availability: "$.available",
};

const domSelectors = Object.fromEntries(
  Object.keys(jsonFields).map((field) => [
    field,
    [
      { selector: `[data-field=${field}]` },
      { selector: `.fallback-${field}`, attribute: "content" },
    ],
  ]),
);

describe("extraction strategy schemas", () => {
  it("parses a strict API request and JSON field map", () => {
    const strategy = ApiExtractionStrategySchema.parse({
      ...extractionBase,
      tier: "api",
      request: {
        method: "POST",
        url: "https://api.shop.test/products/{externalId}",
        headers: { "x-product-source": "{sourceCategory}" },
        query: { canonical: "{productUrl}" },
        body: { ids: ["{externalId}"], include: { price: true } },
      },
      fields: jsonFields,
    });

    expect(strategy.tier).toBe("api");
    expect(strategy.request.body).toEqual({
      ids: ["{externalId}"],
      include: { price: true },
    });
  });

  it("allows typed regional context but rejects stored cookie/authorization headers", () => {
    const regional = ApiExtractionStrategySchema.parse({
      ...extractionBase,
      tier: "api",
      request: {
        method: "GET",
        url: "https://api.shop.test/products/{externalId}",
        headers: { accept: "application/json" },
      },
      regionalContext: {
        kind: "vtex-segment",
        regionId: "v2.ABC_123",
        salesChannel: "2",
        catalogSellerId: "seller-01310",
      },
      fields: jsonFields,
    });
    expect(regional.regionalContext).toEqual({
      kind: "vtex-segment",
      regionId: "v2.ABC_123",
      salesChannel: "2",
      catalogSellerId: "seller-01310",
    });
    expect(JSON.stringify(regional)).not.toMatch(/vtex_segment|cookie/iu);

    for (const name of ["Cookie", "Authorization", "Proxy-Authorization", "Set-Cookie"]) {
      expect(() => ApiExtractionStrategySchema.parse({
        ...extractionBase,
        tier: "api",
        request: {
          method: "GET",
          url: "https://api.shop.test/products/{externalId}",
          headers: { [name]: "must-not-be-stored" },
        },
        fields: jsonFields,
      })).toThrow(/cannot be stored/iu);
    }
  });

  it("parses embedded JSON sources", () => {
    for (const source of [
      { kind: "json-ld" },
      { kind: "next-data" },
      { kind: "script", selector: "script[data-hydration]" },
    ] as const) {
      expect(
        EmbeddedJsonExtractionStrategySchema.parse({
          ...extractionBase,
          tier: "embedded-json",
          request: {
            method: "GET",
            url: "{productUrl}",
            headers: {},
          },
          source,
          fields: jsonFields,
        }).source.kind,
      ).toBe(source.kind);
    }
  });

  it("keeps DOM selector fallbacks ordered", () => {
    const strategy = DomExtractionStrategySchema.parse({
      ...extractionBase,
      tier: "dom",
      url: "{productUrl}",
      selectors: domSelectors,
    });

    expect(strategy.selectors.title.map(({ selector }) => selector)).toEqual([
      "[data-field=title]",
      ".fallback-title",
    ]);
  });

  it("accepts only closed, typed script operations", () => {
    expect(
      ScriptStrategySchema.parse({
        ...extractionBase,
        tier: "script",
        operations: [
          { op: "goto", url: "{productUrl}", timeoutMs: 5_000 },
          { op: "fill", selector: "#cep", value: "01310100" },
          { op: "click", selector: "button[type=submit]" },
          {
            op: "extract",
            source: "dom",
            selectors: domSelectors,
            timeoutMs: 5_000,
          },
        ],
      }).tier,
    ).toBe("script");

    for (const operation of [
      { op: "evaluate", code: "process.env" },
      { op: "filesystem", path: "/etc/passwd" },
      { op: "process", command: "id" },
      { op: "goto", url: "file:///etc/passwd" },
      { op: "click", selector: "button", code: "require('fs')" },
    ]) {
      expect(() =>
        ScriptStrategySchema.parse({
          ...extractionBase,
          tier: "script",
          operations: [operation],
        }),
      ).toThrow();
    }
  });

  it("rejects unknown placeholders recursively and executable extra fields", () => {
    expect(() =>
      ApiExtractionStrategySchema.parse({
        ...extractionBase,
        tier: "api",
        request: {
          method: "POST",
          url: "https://api.shop.test/products",
          headers: {},
          body: { nested: [{ value: "{environment}" }] },
        },
        fields: jsonFields,
      }),
    ).toThrow(/placeholder/i);

    expect(() =>
      ExtractionStrategySchema.parse({
        ...extractionBase,
        tier: "api",
        request: {
          method: "GET",
          url: "{productUrl}",
          headers: {},
          evaluate: "globalThis.process",
        },
        fields: jsonFields,
        score: 1,
      }),
    ).toThrow();
  });

  it("rejects JSONPath filters and method-call expressions", () => {
    for (const unsafePath of [
      "$.items[?(@.price > 0)]",
      "$.items[?(@.name.toString())]",
      "$['constructor']['constructor']('return process')()",
    ]) {
      expect(() => ApiExtractionStrategySchema.parse({
        ...extractionBase,
        tier: "api",
        request: { method: "GET", url: "{productUrl}", headers: {} },
        fields: { ...jsonFields, title: unsafePath },
      })).toThrow(/JSONPath|unsafe/iu);
    }
  });
});

describe("discovery strategy schemas", () => {
  it("parses all four discovery tiers", () => {
    const sitemap = SitemapDiscoveryStrategySchema.parse({
      ...discoveryBase,
      tier: "sitemap",
      sitemapUrls: ["https://shop.test/sitemap.xml"],
    });
    const api = ApiDiscoveryStrategySchema.parse({
      ...discoveryBase,
      tier: "api",
      request: {
        method: "POST",
        url: "https://api.shop.test/search",
        headers: {},
        query: { _from: "{from}", _to: "{to}" },
        body: { page: "{page}", size: "{pageSize}" },
      },
      itemsPath: "$.products[*]",
      refFields: {
        url: "$.link",
        externalId: "$.id",
        sourceCategory: "$.category",
      },
      pagination: {
        kind: "page",
        start: 0,
        pageSize: 50,
        maxPages: 20,
      },
    });
    const dom = DomCrawlDiscoveryStrategySchema.parse({
      ...discoveryBase,
      tier: "dom-crawl",
      startUrls: ["https://shop.test/category/grocery"],
      linkSelectors: [
        { selector: "a.product", attribute: "href" },
        { selector: "[data-product-url]", attribute: "data-product-url" },
      ],
      paginationSelectors: [{ selector: "a.next" }],
    });
    const script = ScriptDiscoveryStrategySchema.parse({
      ...discoveryBase,
      tier: "script",
      operations: [
        { op: "goto", url: "https://shop.test/category/grocery" },
        { op: "scroll", deltaY: 800 },
        {
          op: "extract",
          source: "dom",
          linkSelectors: [{ selector: "a.product", attribute: "href" }],
          timeoutMs: 5_000,
        },
      ],
    });

    expect([sitemap.tier, api.tier, dom.tier, script.tier]).toEqual([
      "sitemap",
      "api",
      "dom-crawl",
      "script",
    ]);
  });

  it("supports bounded page, offset, and cursor API pagination", () => {
    const base = {
      ...discoveryBase,
      tier: "api",
      request: {
        method: "GET",
        url: "https://api.shop.test/products",
        headers: {},
      },
      itemsPath: "$.items[*]",
      refFields: { url: "$.url" },
    } as const;

    expect(
      ApiDiscoveryStrategySchema.parse({
        ...base,
        pagination: {
          kind: "offset",
          start: 0,
          step: 50,
          pageSize: 50,
          maxPages: 10,
        },
      }).pagination.kind,
    ).toBe("offset");
    expect(
      ApiDiscoveryStrategySchema.parse({
        ...base,
        pagination: {
          kind: "cursor",
          initial: null,
          nextCursorPath: "$.nextCursor",
          maxPages: 10,
        },
      }).pagination.kind,
    ).toBe("cursor");
  });

  it("rejects unknown discovery placeholders and unknown object keys", () => {
    expect(() =>
      ApiDiscoveryStrategySchema.parse({
        ...discoveryBase,
        tier: "api",
        request: {
          method: "GET",
          url: "https://api.shop.test/products?token={secret}",
          headers: {},
        },
        itemsPath: "$.items[*]",
        refFields: { url: "$.url" },
        pagination: {
          kind: "page",
          start: 0,
          pageSize: 20,
          maxPages: 2,
        },
      }),
    ).toThrow(/placeholder/i);

    expect(() =>
      DiscoveryStrategySchema.parse({
        ...discoveryBase,
        tier: "sitemap",
        sitemapUrls: ["https://shop.test/sitemap.xml"],
        javascript: "fetch('https://evil.test')",
      }),
    ).toThrow();
  });

  it("requires bounded allocations and provenance-aware request segments", () => {
    const base = {
      ...discoveryBase,
      tier: "api",
      request: {
        method: "POST",
        url: "https://api.shop.test/category",
        headers: {},
        body: { segment: "{segment}", page: "{page}" },
      },
      itemsPath: "$.items[*]",
      refFields: { url: "$.url" },
      pagination: { kind: "page", start: 1, pageSize: 50, maxPages: 20 },
      maxProducts: 1_500,
    } as const;

    expect(ApiDiscoveryStrategySchema.parse({
      ...base,
      segments: [
        { value: "food", sourceCategory: "Alimentos", maxProducts: 1_200 },
        { value: "drinks", sourceCategory: "Bebidas", maxProducts: 300 },
      ],
    }).segments).toHaveLength(2);
    expect(() => ApiDiscoveryStrategySchema.parse({ ...base }))
      .toThrow(/segments.*placeholder|placeholder.*segments/iu);
    expect(() => ApiDiscoveryStrategySchema.parse({
      ...base,
      segments: [
        { value: "food", maxProducts: 1_500 },
        { value: "drinks", maxProducts: 1 },
      ],
    })).toThrow(/allocations.*maxProducts/iu);
  });
});

describe("parseStrategy", () => {
  it("parses either purpose from object or serialized JSON", () => {
    const extraction = {
      ...extractionBase,
      tier: "api",
      request: { method: "GET", url: "{productUrl}", headers: {} },
      fields: jsonFields,
    };
    const discovery = {
      ...discoveryBase,
      tier: "sitemap",
      sitemapUrls: ["https://shop.test/sitemap.xml"],
    };

    expect(parseStrategy(extraction).purpose).toBe("extraction");
    expect(parseStrategy(JSON.stringify(discovery)).purpose).toBe("discovery");
  });
});
