import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { executeDiscovery } from "../../src/discovery/executor.js";
import { RobotsPolicy } from "../../src/discovery/robots.js";
import { SitemapDiscoveryStrategySchema } from "../../src/strategies/schema.js";
import type { ProductRef } from "../../src/strategies/types.js";

async function collect(iterable: AsyncIterable<ProductRef>): Promise<ProductRef[]> {
  const refs: ProductRef[] = [];
  for await (const ref of iterable) refs.push(ref);
  return refs;
}

describe("sitemap discovery", () => {
  it("parses product URLs and enforces robots before yielding", async () => {
    const xml = await readFile(
      new URL("../fixtures/generic/sitemap.xml", import.meta.url),
      "utf8",
    );
    const robotsText = await readFile(
      new URL("../fixtures/generic/robots.txt", import.meta.url),
      "utf8",
    );
    const strategy = SitemapDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "sitemap",
      allowedDomains: ["shop.test"],
      sitemapUrls: ["https://shop.test/sitemap.xml"],
      maxSitemaps: 5,
      maxProducts: 20,
    });

    const refs = await collect(executeDiscovery(strategy, {
      robots: RobotsPolicy.parse("https://shop.test/robots.txt", robotsText),
      fetch: async () => new Response(xml, {
        status: 200,
        headers: { "content-type": "application/xml" },
      }),
    }));

    expect(refs).toEqual([
      {
        canonicalUrl: "https://shop.test/produto/1",
        externalId: null,
        sourceCategory: null,
      },
    ]);
  });

  it("follows sitemap indexes once and terminates recursive loops", async () => {
    const index = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://shop.test/products.xml</loc></sitemap>
      <sitemap><loc>https://shop.test/index.xml</loc></sitemap>
    </sitemapindex>`;
    const products = `<?xml version="1.0"?><urlset>
      <url><loc>https://shop.test/produto/1</loc></url>
      <url><loc>https://shop.test/produto/1?utm_source=duplicate</loc></url>
      <url><loc>https://shop.test/produto/2</loc></url>
    </urlset>`;
    let calls = 0;
    const strategy = SitemapDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "sitemap",
      allowedDomains: ["shop.test"],
      sitemapUrls: ["https://shop.test/index.xml"],
      maxSitemaps: 5,
      maxProducts: 2,
    });

    const refs = await collect(executeDiscovery(strategy, {
      robots: RobotsPolicy.allowAll("https://shop.test"),
      fetch: async (input) => {
        calls += 1;
        return new Response(String(input).endsWith("products.xml") ? products : index);
      },
    }));

    expect(refs.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      "https://shop.test/produto/1",
      "https://shop.test/produto/2",
    ]);
    expect(calls).toBe(2);
  });

  it("bounds and de-duplicates the aggregate sitemap queue", async () => {
    const nested = Array.from(
      { length: 20 },
      (_, index) => `<sitemap><loc>https://shop.test/${index}.xml</loc></sitemap>`,
    ).join("");
    const strategy = SitemapDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "sitemap",
      allowedDomains: ["shop.test"],
      sitemapUrls: ["https://shop.test/index.xml"],
      maxSitemaps: 2,
      maxProducts: 20,
    });
    let calls = 0;

    await collect(executeDiscovery(strategy, {
      robots: RobotsPolicy.allowAll("https://shop.test"),
      fetch: async (input) => {
        calls += 1;
        return new Response(String(input).endsWith("index.xml")
          ? `<sitemapindex>${nested}${nested}</sitemapindex>`
          : "<urlset></urlset>");
      },
    }));

    expect(calls).toBe(2);
  });

  it("decompresses bounded gzip sitemap responses", async () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://shop.test/produto/gzip</loc></url>
    </urlset>`;
    const strategy = SitemapDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "sitemap",
      allowedDomains: ["shop.test"],
      sitemapUrls: ["https://shop.test/products.xml.gz"],
    });

    const refs = await collect(executeDiscovery(strategy, {
      robots: RobotsPolicy.allowAll("https://shop.test"),
      fetch: async () => new Response(gzipSync(xml), {
        headers: { "content-type": "application/gzip" },
      }),
    }));

    expect(refs.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      "https://shop.test/produto/gzip",
    ]);
  });

  it("requires a matching robots policy for the final redirect origin", async () => {
    const strategy = SitemapDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "sitemap",
      allowedDomains: ["shop.test", "cdn.test"],
      sitemapUrls: ["https://shop.test/sitemap.xml"],
    });

    const refs = await collect(executeDiscovery(strategy, {
      robots: RobotsPolicy.allowAll("https://shop.test"),
      fetch: async (input) => String(input).includes("shop.test")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://cdn.test/sitemap.xml" },
          })
        : new Response("<urlset><url><loc>https://shop.test/product/1</loc></url></urlset>"),
    }));

    expect(refs).toEqual([]);
  });

  it("rejects gzip output that exceeds the aggregate body bound", async () => {
    const xml = `<urlset><url><loc>https://shop.test/${"x".repeat(20_000)}</loc></url></urlset>`;
    const strategy = SitemapDiscoveryStrategySchema.parse({
      schemaVersion: 1,
      purpose: "discovery",
      tier: "sitemap",
      allowedDomains: ["shop.test"],
      sitemapUrls: ["https://shop.test/products.xml.gz"],
    });

    await expect(collect(executeDiscovery(strategy, {
      robots: RobotsPolicy.allowAll("https://shop.test"),
      maxBodyBytes: 1_000,
      fetch: async () => new Response(gzipSync(xml)),
    }))).resolves.toEqual([]);
  });
});
