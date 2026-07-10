import type { ExtractionExecutionContext } from "../collection/http.js";
import { canonicalizeRetailerUrl } from "../normalize/url.js";
import type { DiscoveryStrategy } from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import { discoverApi } from "./api.js";
import { discoverDomCrawl } from "./dom-crawl.js";
import type { RobotsPolicy } from "./robots.js";
import { discoverScript } from "./script.js";
import { discoverSitemap } from "./sitemap.js";

export interface DiscoveryExecutionContext extends ExtractionExecutionContext {
  robots?: RobotsPolicy;
}

async function* rawDiscovery(
  strategy: DiscoveryStrategy,
  context: DiscoveryExecutionContext,
): AsyncGenerator<ProductRef> {
  switch (strategy.tier) {
    case "sitemap":
      yield* discoverSitemap(strategy, context);
      return;
    case "api":
      yield* discoverApi(strategy, context);
      return;
    case "dom-crawl":
      yield* await discoverDomCrawl(strategy, context);
      return;
    case "script":
      yield* await discoverScript(strategy, context);
      return;
  }
}

export async function* executeDiscovery(
  strategy: DiscoveryStrategy,
  context: DiscoveryExecutionContext = {},
): AsyncGenerator<ProductRef> {
  const seen = new Set<string>();

  for await (const ref of rawDiscovery(strategy, context)) {
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeRetailerUrl(
        ref.canonicalUrl,
        ref.canonicalUrl,
        strategy.allowedDomains,
      );
    } catch {
      continue;
    }
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    yield { ...ref, canonicalUrl };
    if (seen.size >= strategy.maxProducts) return;
  }
}
