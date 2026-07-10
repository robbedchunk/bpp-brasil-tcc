import type { Page } from "playwright";

import {
  assertNavigationAllowed,
  withRestrictedPage,
} from "../collection/browser.js";
import { canonicalizeRetailerUrl } from "../normalize/url.js";
import type {
  DomCrawlDiscoveryStrategy,
  DomSelector,
} from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import type { DiscoveryExecutionContext } from "./executor.js";
import { robotsCanFetch } from "./robots.js";

async function selectorValues(
  page: Page,
  selectors: DomSelector[],
  defaultAttribute: string,
  maxMatches: number,
): Promise<string[]> {
  for (const candidate of selectors) {
    try {
      const locator = page.locator(candidate.selector);
      const count = Math.min(await locator.count(), maxMatches);
      const values: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        const value = await item.getAttribute(candidate.attribute ?? defaultAttribute);
        if (value !== null && value.trim().length > 0) values.push(value.trim());
      }
      if (values.length > 0) return values;
    } catch {
      // Continue through the declared selector fallback order.
    }
  }
  return [];
}

export async function discoverDomCrawl(
  strategy: DomCrawlDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): Promise<ProductRef[]> {
  return withRestrictedPage(strategy.allowedDomains, context, async (session) => {
    const refs: ProductRef[] = [];
    const seenProducts = new Set<string>();
    const queued = [...strategy.startUrls];
    const seenPages = new Set<string>();

    while (queued.length > 0 && seenPages.size < strategy.maxPages) {
      const rawPageUrl = queued.shift();
      if (rawPageUrl === undefined) break;

      let pageUrl: string;
      try {
        pageUrl = assertNavigationAllowed(rawPageUrl, rawPageUrl, strategy.allowedDomains);
      } catch {
        continue;
      }
      if (seenPages.has(pageUrl) || !robotsCanFetch(context, pageUrl)) continue;
      seenPages.add(pageUrl);
      session.deniedUrl = null;

      try {
        const response = await session.page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: context.timeoutMs ?? 10_000,
        });
        if (session.deniedUrl !== null || response === null || !response.ok()) continue;
        assertNavigationAllowed(session.page.url(), pageUrl, strategy.allowedDomains);
        if (!robotsCanFetch(context, session.page.url())) continue;
      } catch {
        continue;
      }

      const links = await selectorValues(
        session.page,
        strategy.linkSelectors,
        "href",
        context.maxDomMatches ?? 1_000,
      );
      for (const link of links) {
        let canonicalUrl: string;
        try {
          canonicalUrl = canonicalizeRetailerUrl(
            link,
            session.page.url(),
            strategy.allowedDomains,
          );
        } catch {
          continue;
        }
        if (!robotsCanFetch(context, canonicalUrl)) continue;
        if (seenProducts.has(canonicalUrl)) continue;
        seenProducts.add(canonicalUrl);
        refs.push({ canonicalUrl, externalId: null, sourceCategory: null });
        if (refs.length >= strategy.maxProducts) return refs;
      }

      if (strategy.paginationSelectors !== undefined) {
        const [next] = await selectorValues(
          session.page,
          strategy.paginationSelectors,
          "href",
          1,
        );
        if (next !== undefined) {
          try {
            const nextUrl = canonicalizeRetailerUrl(
              next,
              session.page.url(),
              strategy.allowedDomains,
            );
            if (!seenPages.has(nextUrl) && robotsCanFetch(context, nextUrl)) {
              queued.push(nextUrl);
            }
          } catch {
            // Cross-domain pagination is deliberately ignored.
          }
        }
      }
    }

    return refs;
  });
}
