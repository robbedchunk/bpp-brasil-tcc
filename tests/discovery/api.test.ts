import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { executeDiscovery } from "../../src/discovery/executor.js";
import { ApiDiscoveryStrategySchema } from "../../src/strategies/schema.js";
import type { ProductRef } from "../../src/strategies/types.js";

async function collect(iterable: AsyncIterable<ProductRef>): Promise<ProductRef[]> {
  const refs: ProductRef[] = [];
  for await (const ref of iterable) refs.push(ref);
  return refs;
}

describe("API discovery", () => {
  it("terminates page pagination and de-duplicates canonical product URLs", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("../fixtures/generic/discovery-api.json", import.meta.url),
      "utf8",
    )) as { pages: Record<string, unknown> };
    const strategy = ApiDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: {
        method: "GET",
        url: "https://shop.test/api/products",
        headers: {},
        query: { page: "{page}", pageSize: "{pageSize}" },
      },
      itemsPath: "$.products[*]",
      refFields: {
        url: "$.url",
        externalId: "$.id",
        sourceCategory: "$.category",
      },
      pagination: { kind: "page", start: 0, pageSize: 2, maxPages: 5 },
    });

    const refs = await collect(executeDiscovery(strategy, {
      fetch: async (input) => {
        const page = new URL(String(input)).searchParams.get("page") ?? "0";
        return new Response(JSON.stringify(fixture.pages[page]));
      },
    }));

    expect(refs).toEqual([
      { canonicalUrl: "https://shop.test/produto/1", externalId: "1", sourceCategory: "mercearia" },
      { canonicalUrl: "https://shop.test/produto/2", externalId: "2", sourceCategory: "mercearia" },
      { canonicalUrl: "https://shop.test/produto/3", externalId: "3", sourceCategory: "bebidas" },
    ]);
  });

  it("supports offset and cursor pagination with loop termination", async () => {
    const common = {
      schemaVersion: 1,
      purpose: "discovery",
      tier: "api",
      allowedDomains: ["shop.test"],
      itemsPath: "$.items[*]",
      refFields: { url: "$.url", externalId: "$.id" },
    } as const;
    const offset = ApiDiscoveryStrategySchema.parse({
      ...common,
      request: {
        method: "GET",
        url: "https://shop.test/api/products",
        headers: {},
        query: { offset: "{offset}" },
      },
      pagination: { kind: "offset", start: 0, step: 2, pageSize: 2, maxPages: 5 },
    });
    const cursor = ApiDiscoveryStrategySchema.parse({
      ...common,
      request: {
        method: "GET",
        url: "https://shop.test/api/products",
        headers: {},
        query: { cursor: "{cursor}" },
      },
      pagination: {
        kind: "cursor",
        initial: null,
        nextCursorPath: "$.nextCursor",
        maxPages: 5,
      },
    });

    const offsetRefs = await collect(executeDiscovery(offset, {
      fetch: async (input) => {
        const value = Number(new URL(String(input)).searchParams.get("offset"));
        return new Response(JSON.stringify({
          items: value === 0
            ? [{ url: "/produto/1", id: "1" }, { url: "/produto/2", id: "2" }]
            : value === 2 ? [{ url: "/produto/3", id: "3" }] : [],
        }));
      },
    }));
    const cursorRefs = await collect(executeDiscovery(cursor, {
      fetch: async (input) => {
        const value = new URL(String(input)).searchParams.get("cursor");
        return new Response(JSON.stringify(value === "next"
          ? { items: [{ url: "/produto/3", id: "3" }], nextCursor: "next" }
          : {
              items: [{ url: "/produto/1", id: "1" }, { url: "/produto/2", id: "2" }],
              nextCursor: "next",
            }));
      },
    }));

    expect(offsetRefs).toHaveLength(3);
    expect(cursorRefs).toHaveLength(3);
  });

  it("percent-encodes pagination placeholders used inside request URLs", async () => {
    let requestedUrl = "";
    const strategy = ApiDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "api",
      allowedDomains: ["shop.test"],
      request: {
        method: "GET",
        url: "https://shop.test/api/{cursor}",
        headers: {},
      },
      itemsPath: "$.items[*]",
      refFields: { url: "$.url" },
      pagination: {
        kind: "cursor",
        initial: "next&admin=true/segment",
        nextCursorPath: "$.nextCursor",
        maxPages: 1,
      },
    });

    await collect(executeDiscovery(strategy, {
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ items: [] }));
      },
    }));

    expect(requestedUrl).toBe(
      "https://shop.test/api/next%26admin%3Dtrue%2Fsegment",
    );
  });
});
