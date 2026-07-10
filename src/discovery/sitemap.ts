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
import { DiscoveryFailureError } from "./failure.js";
import { robotsCanFetch } from "./robots.js";

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
  const parsed = parser.parse(xml) as unknown;
  if (
    parsed === null
    || typeof parsed !== "object"
    || (!("sitemapindex" in parsed) && !("urlset" in parsed))
  ) {
    throw new Error("XML document has no sitemapindex or urlset root");
  }
  const document = parsed as {
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

function hasRobotsPolicy(
  context: DiscoveryExecutionContext,
  target: string,
): boolean {
  const origin = new URL(target).origin;
  return context.robots?.origin === origin || context.robotsByOrigin?.has(origin) === true;
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

export async function* discoverSitemap(
  strategy: SitemapDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): AsyncGenerator<ProductRef> {
  const queue: string[] = [];
  const queuedSitemaps = new Set<string>();
  const seenSitemaps = new Set<string>();
  const seenProducts = new Set<string>();

  const enqueue = (candidate: string, baseUrl: string): void => {
    if (queuedSitemaps.size + seenSitemaps.size >= strategy.maxSitemaps) return;
    try {
      const canonical = canonicalizeRetailerUrl(
        candidate,
        baseUrl,
        strategy.allowedDomains,
      );
      if (seenSitemaps.has(canonical) || queuedSitemaps.has(canonical)) return;
      queuedSitemaps.add(canonical);
      queue.push(canonical);
    } catch {
      // Ignore cross-domain or malformed sitemap members.
    }
  };

  for (const sitemapUrl of strategy.sitemapUrls) enqueue(sitemapUrl, sitemapUrl);

  while (queue.length > 0 && seenSitemaps.size < strategy.maxSitemaps) {
    const candidate = queue.shift();
    if (candidate === undefined) break;

    const sitemapUrl = candidate;
    queuedSitemaps.delete(sitemapUrl);
    if (seenSitemaps.has(sitemapUrl)) continue;
    if (!hasRobotsPolicy(context, sitemapUrl)) {
      throw new DiscoveryFailureError({
        category: "domain-denied",
        message: `No robots policy is established for ${new URL(sitemapUrl).origin}`,
        responded: false,
      });
    }
    if (!robotsCanFetch(context, sitemapUrl)) {
      throw new DiscoveryFailureError({
        category: "domain-denied",
        message: "Sitemap entry point is denied by robots policy",
        responded: false,
      });
    }
    seenSitemaps.add(sitemapUrl);

    await context.beforeRequest?.();
    const fetched = await fetchBounded(
      { url: sitemapUrl, method: "GET" },
      strategy.allowedDomains,
      context,
    );
    if (!fetched.ok) throw new DiscoveryFailureError(fetched.failure);
    if (!hasRobotsPolicy(context, fetched.response.url)) {
      throw new DiscoveryFailureError({
        category: "domain-denied",
        message: `No robots policy is established for ${new URL(fetched.response.url).origin}`,
        responded: true,
        statusCode: fetched.response.status,
      });
    }
    if (!robotsCanFetch(context, fetched.response.url)) {
      throw new DiscoveryFailureError({
        category: "domain-denied",
        message: "Sitemap redirect target is denied by robots policy",
        responded: true,
        statusCode: fetched.response.status,
      });
    }

    let parsed: ParsedSitemap;
    try {
      parsed = parseSitemapXml(responseXml(
        fetched.response.bytes,
        fetched.response.body,
        context.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ));
    } catch (error) {
      throw new DiscoveryFailureError({
        category: "parse",
        message: "Sitemap response could not be parsed",
        responded: true,
        statusCode: fetched.response.status,
      }, { cause: error });
    }

    for (const nested of parsed.sitemapUrls) {
      enqueue(nested, sitemapUrl);
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
      if (!robotsCanFetch(context, canonicalUrl)) continue;
      if (seenProducts.has(canonicalUrl)) continue;
      seenProducts.add(canonicalUrl);
      yield { canonicalUrl, externalId: null, sourceCategory: null };
      if (seenProducts.size >= strategy.maxProducts) return;
    }
  }
}
