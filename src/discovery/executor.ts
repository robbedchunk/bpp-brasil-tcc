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
  robotsByOrigin?: ReadonlyMap<string, RobotsPolicy>;
  beforeRequest?: () => Promise<void>;
  reportCompletion?: (evidence: DiscoveryCompletionEvidence) => void;
  reportRefDocument?: (ref: ProductRef, documentUrl: string) => void;
  stopAfterProducts?: number;
}

export interface DiscoveryCompletionEvidence {
  complete: boolean;
  reason:
    | "source_exhausted"
    | "product_cap_reached"
    | "page_cap_reached"
    | "request_cap_reached"
    | "loop_guard_triggered";
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
