import { readFile } from "node:fs/promises";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeDiscovery } from "../../src/discovery/executor.js";
import { ScriptDiscoveryStrategySchema } from "../../src/strategies/schema.js";
import type { ProductRef } from "../../src/strategies/types.js";
import {
  startLocalHttpServer,
  type LocalHttpServer,
} from "../helpers/local-http-server.js";

async function collect(iterable: AsyncIterable<ProductRef>): Promise<ProductRef[]> {
  const refs: ProductRef[] = [];
  for await (const ref of iterable) refs.push(ref);
  return refs;
}

describe("script discovery", () => {
  let browser: Browser;
  let server: LocalHttpServer;

  beforeAll(async () => {
    const html = await readFile(
      new URL("../fixtures/generic/category.html", import.meta.url),
      "utf8",
    );
    server = await startLocalHttpServer((request, response) => {
      if (request.url === "/api/products") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ items: [
          { url: "/produto/4", id: "4", category: "padaria" },
          { url: "/produto/5", id: "5", category: "hortifruti" },
        ] }));
        return;
      }
      response.end(html);
    });
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("uses the restricted browser operations and yields de-duplicated refs", async () => {
    const strategy = ScriptDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "script",
      allowedDomains: ["127.0.0.1"],
      operations: [
        { op: "goto", url: `${server.origin}/categoria` },
        { op: "waitFor", selector: "a.product", state: "attached" },
        { op: "scroll", deltaY: 300 },
        {
          op: "extract",
          source: "dom",
          linkSelectors: [{ selector: "a.product", attribute: "href" }],
        },
      ],
      maxProducts: 10,
    });

    const refs = await collect(executeDiscovery(strategy, { browser }));

    expect(refs.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      `${server.origin}/produto/1`,
      `${server.origin}/produto/2`,
    ]);
  });

  it("does not navigate to a configured target outside the allowlist", async () => {
    const strategy = ScriptDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "script",
      allowedDomains: ["shop.test"],
      operations: [
        { op: "goto", url: `${server.origin}/categoria` },
        { op: "extract", source: "dom", linkSelectors: [{ selector: "a" }] },
      ],
    });

    await expect(collect(executeDiscovery(strategy, { browser }))).resolves.toEqual([]);
  });

  it("maps refs from an allowlisted saved HTTP JSON operation", async () => {
    const strategy = ScriptDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "script",
      allowedDomains: ["127.0.0.1"],
      operations: [
        {
          op: "http",
          request: { method: "GET", url: `${server.origin}/api/products`, headers: {} },
          saveAs: "catalog",
        },
        {
          op: "extract",
          source: "json",
          from: "catalog",
          itemsPath: "$.items[*]",
          refFields: {
            url: "$.url",
            externalId: "$.id",
            sourceCategory: "$.category",
          },
        },
      ],
    });

    const refs = await collect(executeDiscovery(strategy, { browser }));

    expect(refs).toEqual([
      { canonicalUrl: `${server.origin}/produto/4`, externalId: "4", sourceCategory: "padaria" },
      { canonicalUrl: `${server.origin}/produto/5`, externalId: "5", sourceCategory: "hortifruti" },
    ]);
  });

  it("cancels an in-flight HTTP operation at the total deadline", async () => {
    const strategy = ScriptDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
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
          itemsPath: "$.items[*]",
          refFields: { url: "$.url" },
        },
      ],
    });
    let active = 0;
    let aborted = false;
    const startedAt = Date.now();

    const refs = await collect(executeDiscovery(strategy, {
      browser,
      totalTimeoutMs: 25,
      fetch: async (_input, init) => {
        active += 1;
        try {
          await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(init.signal?.reason);
            }, { once: true });
          });
        } finally {
          active -= 1;
        }
        throw new Error("unreachable");
      },
    }));

    expect(refs).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(active).toBe(0);
  });

  it("cancels a total-deadline discovery goto fetch before returning", async () => {
    const strategy = ScriptDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "script",
      allowedDomains: ["shop.test"],
      operations: [
        { op: "goto", url: "https://shop.test/pending", timeoutMs: 2_000 },
        { op: "extract", source: "dom", linkSelectors: [{ selector: "a" }] },
      ],
    });
    let active = 0;
    let aborted = false;
    const startedAt = Date.now();

    const refs = await collect(executeDiscovery(strategy, {
      browser,
      totalTimeoutMs: 200,
      fetch: async (_input, init) => {
        active += 1;
        try {
          await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(init.signal?.reason);
            }, { once: true });
          });
        } finally {
          active -= 1;
        }
        throw new Error("unreachable");
      },
    }));

    expect(refs).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(750);
    expect(aborted).toBe(true);
    expect(active).toBe(0);
  });

  it("cancels an operation-timeout discovery click fetch before returning", async () => {
    const strategy = ScriptDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "script",
      allowedDomains: ["shop.test"],
      operations: [
        { op: "goto", url: "https://shop.test/start", timeoutMs: 500 },
        { op: "click", selector: "#next", timeoutMs: 100 },
        { op: "extract", source: "dom", linkSelectors: [{ selector: "a" }] },
      ],
    });
    let active = 0;
    let aborted = false;
    const startedAt = Date.now();

    const refs = await collect(executeDiscovery(strategy, {
      browser,
      timeoutMs: 1_000,
      totalTimeoutMs: 2_000,
      fetch: async (input, init) => {
        if (String(input).endsWith("/start")) {
          return new Response('<a id="next" href="/pending">next</a>', {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        active += 1;
        try {
          await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(init.signal?.reason);
            }, { once: true });
          });
        } finally {
          active -= 1;
        }
        throw new Error("unreachable");
      },
    }));

    expect(refs).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(750);
    expect(aborted).toBe(true);
    expect(active).toBe(0);
  });
});
