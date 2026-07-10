import { gunzipSync } from "node:zlib";

import { XMLParser } from "fast-xml-parser";

import {
  DEFAULT_MAX_BODY_BYTES,
  fetchBounded,
} from "../collection/http.js";
import { canonicalizeRetailerUrl } from "../normalize/url.js";
import type { SitemapDiscoveryStrategy } from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import type { DiscoveryExecutionContext } from "./executor.js";

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  processEntities: false,
  trimValues: true,
});

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function locationValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value !== null && typeof value === "object" && "#text" in value) {
    const text = (value as { "#text": unknown })["#text"];
    return typeof text === "string" ? text.trim() || null : null;
  }
  return null;
}

interface ParsedSitemap {
  sitemapUrls: string[];
  productUrls: string[];
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  const document = parser.parse(xml) as {
    sitemapindex?: { sitemap?: Array<{ loc?: unknown }> | { loc?: unknown } };
    urlset?: { url?: Array<{ loc?: unknown }> | { loc?: unknown } };
  };
  const sitemapUrls = arrayOf(document.sitemapindex?.sitemap)
    .map((entry) => locationValue(entry.loc))
    .filter((url): url is string => url !== null);
  const productUrls = arrayOf(document.urlset?.url)
    .map((entry) => locationValue(entry.loc))
    .filter((url): url is string => url !== null);
  return { sitemapUrls, productUrls };
}

function responseXml(
  bytes: Uint8Array,
  body: string,
  maxOutputBytes: number,
): string {
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzip) return body;
  const decompressed = gunzipSync(bytes, { maxOutputLength: maxOutputBytes });
  return new TextDecoder().decode(decompressed);
}

function matchingRobots(context: DiscoveryExecutionContext, url: string): boolean {
  const policy = context.robots;
  return policy !== undefined && policy.canFetch(url);
}

export async function* discoverSitemap(
  strategy: SitemapDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): AsyncGenerator<ProductRef> {
  const queue = [...strategy.sitemapUrls];
  const seenSitemaps = new Set<string>();
  let products = 0;

  while (queue.length > 0 && seenSitemaps.size < strategy.maxSitemaps) {
    const candidate = queue.shift();
    if (candidate === undefined) break;

    let sitemapUrl: string;
    try {
      sitemapUrl = canonicalizeRetailerUrl(
        candidate,
        candidate,
        strategy.allowedDomains,
      );
    } catch {
      continue;
    }
    if (seenSitemaps.has(sitemapUrl) || !matchingRobots(context, sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    const fetched = await fetchBounded(
      { url: sitemapUrl, method: "GET" },
      strategy.allowedDomains,
      context,
    );
    if (!fetched.ok) continue;

    let parsed: ParsedSitemap;
    try {
      parsed = parseSitemapXml(responseXml(
        fetched.response.bytes,
        fetched.response.body,
        context.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ));
    } catch {
      continue;
    }

    for (const nested of parsed.sitemapUrls) {
      try {
        const nestedUrl = canonicalizeRetailerUrl(
          nested,
          sitemapUrl,
          strategy.allowedDomains,
        );
        if (!seenSitemaps.has(nestedUrl)) queue.push(nestedUrl);
      } catch {
        // Ignore cross-domain or malformed sitemap members.
      }
    }

    for (const product of parsed.productUrls) {
      let canonicalUrl: string;
      try {
        canonicalUrl = canonicalizeRetailerUrl(
          product,
          sitemapUrl,
          strategy.allowedDomains,
        );
      } catch {
        continue;
      }
      if (!matchingRobots(context, canonicalUrl)) continue;
      yield { canonicalUrl, externalId: null, sourceCategory: null };
      products += 1;
      if (products >= strategy.maxProducts) return;
    }
  }
}
