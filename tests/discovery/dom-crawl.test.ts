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

  beforeAll(async () => {
    const firstPage = await readFile(
      new URL("../fixtures/generic/category.html", import.meta.url),
      "utf8",
    );
    server = await startLocalHttpServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
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

    const refs = await collect(executeDiscovery(strategy, { browser, robots }));

    expect(refs).toEqual([
      { canonicalUrl: `${server.origin}/produto/1`, externalId: null, sourceCategory: null },
      { canonicalUrl: `${server.origin}/produto/3`, externalId: null, sourceCategory: null },
    ]);
  });
});

