import { readFile } from "node:fs/promises";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeDiscovery } from "../../src/discovery/executor.js";
import { RobotsPolicy } from "../../src/discovery/robots.js";
import { DomCrawlDiscoveryStrategySchema } from "../../src/strategies/schema.js";
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

describe("DOM crawl discovery", () => {
  let browser: Browser;
  let server: LocalHttpServer;
  let visibleSideEffects = 0;

  beforeAll(async () => {
    const firstPage = await readFile(
      new URL("../fixtures/generic/category.html", import.meta.url),
      "utf8",
    );
    server = await startLocalHttpServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/redirect-origin") {
        const host = request.headers.host?.replace("127.0.0.1", "localhost");
        response.writeHead(302, { location: `http://${host}/final-origin` });
        response.end();
        return;
      }
      if (request.url === "/final-origin") {
        response.end(`<script src="/visible-side-effect.js"></script>
          <a class="product" href="http://127.0.0.1:${server.origin.split(":").at(-1)}/produto/1">1</a>`);
        return;
      }
      if (request.url === "/visible-side-effect.js") {
        visibleSideEffects += 1;
        response.setHeader("content-type", "text/javascript");
        response.end("document.body.dataset.executed = 'true'");
        return;
      }
      if (request.url === "/many") {
        response.end(Array.from(
          { length: 5 },
          (_, index) => `<a class="product" href="/produto/${index + 1}">${index + 1}</a>`,
        ).join(""));
        return;
      }
      if (request.url === "/throttled") {
        response.statusCode = 429;
        response.end("throttled");
        return;
      }
      response.end(request.url === "/categoria?page=2"
        ? `<a class="product" href="/produto/2">2</a>
           <a class="product" href="/produto/3">3</a>
           <a class="next" href="/categoria?page=2">loop</a>`
        : firstPage);
    });
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("follows bounded pagination, robots, and canonical URL de-duplication", async () => {
    const strategy = DomCrawlDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "dom-crawl",
      allowedDomains: ["127.0.0.1"],
      startUrls: [`${server.origin}/categoria?page=1`],
      linkSelectors: [{ selector: "a.product", attribute: "href" }],
      paginationSelectors: [{ selector: "a.next", attribute: "href" }],
      maxPages: 5,
      maxProducts: 10,
    });
    const robots = RobotsPolicy.parse(
      `${server.origin}/robots.txt`,
      "User-agent: *\nDisallow: /produto/2\n",
    );

    let gated = 0;
    const refs = await collect(executeDiscovery(strategy, {
      browser,
      robots,
      beforeRequest: async () => { gated += 1; },
    }));

    expect(refs).toEqual([
      { canonicalUrl: `${server.origin}/produto/1`, externalId: null, sourceCategory: null },
      { canonicalUrl: `${server.origin}/produto/3`, externalId: null, sourceCategory: null },
    ]);
    expect(gated).toBe(2);
  });

  it("applies product caps after canonical de-duplication", async () => {
    const strategy = DomCrawlDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "dom-crawl",
      allowedDomains: ["127.0.0.1"],
      startUrls: [`${server.origin}/categoria?page=1`],
      linkSelectors: [{ selector: "a.product", attribute: "href" }],
      maxPages: 1,
      maxProducts: 2,
    });

    const refs = await collect(executeDiscovery(strategy, {
      browser,
      robots: RobotsPolicy.allowAll(server.origin),
    }));

    expect(refs.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      `${server.origin}/produto/1`,
      `${server.origin}/produto/2`,
    ]);
  });

  it("bounds selector traversal before reading every match", async () => {
    const strategy = DomCrawlDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "dom-crawl",
      allowedDomains: ["127.0.0.1"],
      startUrls: [`${server.origin}/many`],
      linkSelectors: [{ selector: "a.product", attribute: "href" }],
      maxPages: 1,
      maxProducts: 10,
    });

    const refs = await collect(executeDiscovery(strategy, {
      browser,
      robots: RobotsPolicy.allowAll(server.origin),
      maxDomMatches: 2,
    }));

    expect(refs).toHaveLength(2);
  });

  it("blocks the final-origin visible side effect before parsing", async () => {
    visibleSideEffects = 0;
    const strategy = DomCrawlDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "dom-crawl",
      allowedDomains: ["127.0.0.1", "localhost"],
      startUrls: [`${server.origin}/redirect-origin`],
      linkSelectors: [{ selector: "a.product", attribute: "href" }],
      maxPages: 1,
      maxProducts: 10,
    });

    await expect(collect(executeDiscovery(strategy, {
      browser,
      robots: RobotsPolicy.allowAll(server.origin),
    }))).rejects.toMatchObject({ failure: { category: "domain-denied" } });

    expect(visibleSideEffects).toBe(0);
  });

  it("propagates HTTP failures and missing robots context as categorized failures", async () => {
    const strategy = DomCrawlDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "dom-crawl",
      allowedDomains: ["127.0.0.1"],
      startUrls: [`${server.origin}/throttled`],
      linkSelectors: [{ selector: "a.product", attribute: "href" }],
      maxPages: 1,
      maxProducts: 10,
    });

    await expect(collect(executeDiscovery(strategy, {
      browser,
      robots: RobotsPolicy.allowAll(server.origin),
    }))).rejects.toMatchObject({ failure: { category: "http-429" } });

    await expect(collect(executeDiscovery(strategy, { browser })))
      .rejects.toMatchObject({ failure: { category: "domain-denied" } });
  });
});
