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
import { DiscoveryFailureError } from "./failure.js";
import { robotsCanFetch } from "./robots.js";

function hasRobotsPolicy(context: DiscoveryExecutionContext, target: string): boolean {
  const origin = new URL(target).origin;
  return context.robots?.origin === origin || context.robotsByOrigin?.has(origin) === true;
}

function pageFailure(status: number): DiscoveryFailureError {
  const category = status === 403
    ? "http-403"
    : status === 429
      ? "http-429"
      : status === 408 || status === 504
        ? "timeout"
        : "unknown";
  return new DiscoveryFailureError({
    category,
    message: `DOM discovery navigation returned HTTP ${status}`,
    responded: true,
    statusCode: status,
  });
}

function browserFailure(error: unknown): DiscoveryFailureError {
  if (error instanceof DiscoveryFailureError) return error;
  const message = error instanceof Error ? error.message : String(error) || "Browser request failed";
  const timeout = error instanceof Error
    && (error.name === "TimeoutError" || /timeout|timed out/iu.test(error.message));
  return new DiscoveryFailureError({
    category: timeout ? "timeout" : "network",
    message,
    responded: false,
  }, { cause: error });
}

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
  const restrictedContext: DiscoveryExecutionContext = {
    ...context,
    allowDocumentUrl: (url) => robotsCanFetch(context, url),
  };
  try {
    return await withRestrictedPage(strategy.allowedDomains, restrictedContext, async (session) => {
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
      } catch (error) {
        throw new DiscoveryFailureError({
          category: "domain-denied",
          message: error instanceof Error ? error.message : "DOM discovery URL is denied",
          responded: false,
        }, { cause: error });
      }
      if (seenPages.has(pageUrl)) continue;
      if (!hasRobotsPolicy(context, pageUrl)) {
        throw new DiscoveryFailureError({
          category: "domain-denied",
          message: `No robots policy is established for ${new URL(pageUrl).origin}`,
          responded: false,
        });
      }
      if (!robotsCanFetch(context, pageUrl)) {
        throw new DiscoveryFailureError({
          category: "domain-denied",
          message: "DOM discovery entry point is denied by robots policy",
          responded: false,
        });
      }
      seenPages.add(pageUrl);
      session.deniedUrl = null;
      session.policyDenied = false;

      try {
        await context.beforeRequest?.();
        const response = await session.page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: context.timeoutMs ?? 10_000,
        });
        if (session.deniedUrl !== null || session.policyDenied) {
          throw new DiscoveryFailureError({
            category: "domain-denied",
            message: "DOM discovery navigation was denied by domain or robots policy",
            responded: response !== null,
            ...(response === null ? {} : { statusCode: response.status() }),
          });
        }
        if (session.redirectLimitExceeded) {
          throw new DiscoveryFailureError({
            category: "network",
            message: "DOM discovery exceeded the redirect limit",
            responded: response !== null,
          });
        }
        if (session.bodyLimitExceeded) {
          throw new DiscoveryFailureError({
            category: "parse",
            message: "DOM discovery response exceeded the body limit",
            responded: response !== null,
          });
        }
        if (response === null) {
          throw new DiscoveryFailureError({
            category: "network",
            message: "DOM discovery navigation returned no response",
            responded: false,
          });
        }
        if (!response.ok()) throw pageFailure(response.status());
        assertNavigationAllowed(session.page.url(), pageUrl, strategy.allowedDomains);
        const finalUrl = session.finalDocumentUrl ?? session.page.url();
        if (!hasRobotsPolicy(context, finalUrl) || !robotsCanFetch(context, finalUrl)) {
          throw new DiscoveryFailureError({
            category: "domain-denied",
            message: "No permitting robots policy is established for the final DOM origin",
            responded: true,
            statusCode: response.status(),
          });
        }
      } catch (error) {
        if (session.deniedUrl !== null || session.policyDenied) {
          throw new DiscoveryFailureError({
            category: "domain-denied",
            message: "DOM discovery request was blocked before parsing",
            responded: false,
          }, { cause: error });
        }
        throw browserFailure(error);
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
            session.finalDocumentUrl ?? session.page.url(),
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
              session.finalDocumentUrl ?? session.page.url(),
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
  } catch (error) {
    throw browserFailure(error);
  }
}
