import type { Page } from "playwright";

import type { DomExtractionStrategy } from "../strategies/schema.js";
import type {
  ExtractionFailure,
  ExtractionResult,
  FailureCategory,
  ProductRef,
} from "../strategies/types.js";
import {
  assertNavigationAllowed,
  DomainDeniedError,
  withRestrictedPage,
} from "./browser.js";
import {
  mapExtractionFields,
  type RawExtractionFields,
} from "./field-map.js";
import {
  renderUrlTemplate,
  type ExtractionExecutionContext,
} from "./http.js";

type SelectorList = DomExtractionStrategy["selectors"][keyof DomExtractionStrategy["selectors"]];

function failure(
  category: FailureCategory,
  message: string,
  responded: boolean,
  statusCode?: number,
): ExtractionResult {
  const detail: ExtractionFailure = statusCode === undefined
    ? { category, message, responded }
    : { category, message, responded, statusCode };
  return { ok: false, failure: detail };
}

async function readFirst(page: Page, selectors: SelectorList): Promise<string | null> {
  for (const candidate of selectors) {
    try {
      const locator = page.locator(candidate.selector).first();
      if (await locator.count() === 0) continue;
      const value = candidate.attribute === undefined
        ? await locator.textContent()
        : await locator.getAttribute(candidate.attribute);
      if (value !== null && value.trim().length > 0) return value.trim();
    } catch {
      // A malformed or stale fallback must not prevent trying the next selector.
    }
  }
  return null;
}

async function collectFields(
  page: Page,
  strategy: DomExtractionStrategy,
): Promise<RawExtractionFields> {
  const { selectors } = strategy;
  const [title, brand, price, promoPrice, unit, availability] = await Promise.all([
    readFirst(page, selectors.title),
    readFirst(page, selectors.brand),
    readFirst(page, selectors.price),
    readFirst(page, selectors.promoPrice),
    readFirst(page, selectors.unit),
    readFirst(page, selectors.availability),
  ]);
  return { title, brand, price, promoPrice, unit, availability };
}

function errorCategory(error: unknown): FailureCategory {
  if (error instanceof DomainDeniedError) return "domain-denied";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "network";
}

export async function executeDom(
  strategy: DomExtractionStrategy,
  ref: ProductRef,
  executionContext: ExtractionExecutionContext = {},
): Promise<ExtractionResult> {
  let target: string;
  try {
    target = renderUrlTemplate(strategy.url, ref);
    target = assertNavigationAllowed(target, ref.canonicalUrl, strategy.allowedDomains);
  } catch (error) {
    return failure(
      errorCategory(error),
      error instanceof Error ? error.message : "Navigation target was rejected",
      false,
    );
  }

  try {
    return await withRestrictedPage(
      strategy.allowedDomains,
      executionContext,
      async (session) => {
        try {
          const response = await session.page.goto(target, {
            waitUntil: "domcontentloaded",
            timeout: executionContext.timeoutMs ?? 10_000,
          });
          if (session.deniedUrl !== null) throw new DomainDeniedError(session.deniedUrl);
          assertNavigationAllowed(session.page.url(), target, strategy.allowedDomains);
          if (response === null) return failure("network", "Navigation produced no response", false);
          if (response.status() === 403) {
            return failure("http-403", "HTTP 403", true, 403);
          }
          if (response.status() === 429) {
            return failure("http-429", "HTTP 429", true, 429);
          }
          if (!response.ok()) {
            return failure("network", `HTTP ${response.status()}`, true, response.status());
          }
          return mapExtractionFields(await collectFields(session.page, strategy));
        } catch (error) {
          if (session.deniedUrl !== null) {
            return failure("domain-denied", `URL domain is not allowed: ${session.deniedUrl}`, false);
          }
          if (session.bodyLimitExceeded) {
            return failure("parse", "Browser response exceeded maxBodyBytes", true);
          }
          return failure(
            errorCategory(error),
            error instanceof Error ? error.message : "Browser extraction failed",
            false,
          );
        }
      },
    );
  } catch (error) {
    return failure(
      errorCategory(error),
      error instanceof Error ? error.message : "Browser could not be started",
      false,
    );
  }
}
