import type { Page } from "playwright";

import {
  assertNavigationAllowed,
  type RestrictedPageSession,
  withRestrictedPage,
} from "../collection/browser.js";
import { fetchBounded } from "../collection/http.js";
import { canonicalizeRetailerUrl } from "../normalize/url.js";
import {
  safeJsonPathValue,
  safeJsonPathValues,
} from "../strategies/json-path.js";
import type {
  DiscoveryRequestTemplate,
  DiscoveryScriptOperation,
  ScriptDiscoveryStrategy,
} from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import { renderDiscoveryRequest } from "./api.js";
import type { DiscoveryExecutionContext } from "./executor.js";

const MAX_OPERATIONS = 100;
const MAX_TOTAL_RUNTIME_MS = 60_000;
const EMPTY_PAGINATION = {
  page: "0",
  pageSize: "",
  offset: "0",
  from: "0",
  to: "0",
  cursor: "",
};

type DomExtract = Extract<DiscoveryScriptOperation, { op: "extract"; source: "dom" }>;
type JsonExtract = Extract<DiscoveryScriptOperation, { op: "extract"; source: "json" }>;

interface SavedJson {
  document: unknown;
  baseUrl: string;
}

async function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withTotalDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  cancel: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellation = Promise.resolve();
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(`Script exceeded ${timeoutMs} ms`);
      controller.abort(error);
      cancellation = cancel().catch(() => undefined);
      reject(error);
    }, timeoutMs);
  });
  const work = Promise.resolve().then(operation);
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (timedOut) {
      await cancellation;
      await work.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function renderDiscoveryString(template: string): string {
  return template.replace(
    /\{(page|pageSize|offset|from|to|cursor)\}/gu,
    (_match, name: keyof typeof EMPTY_PAGINATION) => EMPTY_PAGINATION[name],
  );
}

async function selectorLinks(
  page: Page,
  selectors: DomExtract["linkSelectors"],
  timeoutMs: number,
  maxMatches: number,
): Promise<string[]> {
  for (const candidate of selectors) {
    try {
      const locator = page.locator(candidate.selector);
      const count = Math.min(await locator.count(), maxMatches);
      const values: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const value = await locator.nth(index).getAttribute(
          candidate.attribute ?? "href",
          { timeout: timeoutMs },
        );
        if (value !== null && value.trim().length > 0) values.push(value.trim());
      }
      if (values.length > 0) return values;
    } catch {
      // Continue through the declared fallback order.
    }
  }
  return [];
}

function jsonValues(document: unknown, path: string): unknown[] {
  const values = safeJsonPathValues(document, path);
  if (values.length === 1 && Array.isArray(values[0])) return values[0] as unknown[];
  return values;
}

function jsonValue(document: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  return safeJsonPathValue(document, path);
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const string = String(value).trim();
  return string.length === 0 ? null : string;
}

function jsonRefs(
  saved: SavedJson,
  operation: JsonExtract,
  strategy: ScriptDiscoveryStrategy,
): ProductRef[] {
  const refs: ProductRef[] = [];
  for (const item of jsonValues(saved.document, operation.itemsPath)) {
    const rawUrl = jsonValue(item, operation.refFields.url);
    if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) continue;
    try {
      refs.push({
        canonicalUrl: canonicalizeRetailerUrl(
          rawUrl,
          saved.baseUrl,
          strategy.allowedDomains,
        ),
        externalId: optionalString(jsonValue(item, operation.refFields.externalId)),
        sourceCategory: optionalString(jsonValue(item, operation.refFields.sourceCategory)),
      });
    } catch {
      // Ignore malformed or cross-domain discovered URLs.
    }
  }
  return refs;
}

async function pageOperation(
  operation: Exclude<DiscoveryScriptOperation, { op: "http" } | { op: "extract" }>,
  page: Page,
  strategy: ScriptDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): Promise<void> {
  const timeout = operation.timeoutMs ?? context.timeoutMs ?? 10_000;
  switch (operation.op) {
    case "goto": {
      const rendered = renderDiscoveryString(operation.url);
      const target = assertNavigationAllowed(rendered, rendered, strategy.allowedDomains);
      const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout });
      if (response === null || !response.ok()) throw new Error("Navigation failed");
      assertNavigationAllowed(page.url(), target, strategy.allowedDomains);
      return;
    }
    case "click":
      await page.locator(operation.selector).first().click({ timeout });
      return;
    case "fill":
      await page.locator(operation.selector).first().fill(
        renderDiscoveryString(operation.value),
        { timeout },
      );
      return;
    case "select":
      await page.locator(operation.selector).first().selectOption(
        renderDiscoveryString(operation.value),
        { timeout },
      );
      return;
    case "waitFor":
      await page.locator(operation.selector).first().waitFor({
        state: operation.state ?? "visible",
        timeout,
      });
      return;
    case "scroll":
      await page.mouse.wheel(0, operation.deltaY);
      return;
  }
}

async function runDiscoveryProgram(
  strategy: ScriptDiscoveryStrategy,
  context: DiscoveryExecutionContext,
  session: RestrictedPageSession,
): Promise<ProductRef[]> {
  const refs: ProductRef[] = [];
  const seenRefs = new Set<string>();
  const savedJson = new Map<string, SavedJson>();

  const appendRef = (ref: ProductRef): boolean => {
    if (seenRefs.has(ref.canonicalUrl)) return false;
    seenRefs.add(ref.canonicalUrl);
    refs.push(ref);
    return refs.length >= strategy.maxProducts;
  };

  try {
    for (const operation of strategy.operations) {
      if (
        session.deniedUrl !== null
        || session.bodyLimitExceeded
        || session.redirectLimitExceeded
        || session.policyDenied
      ) return [];

      if (operation.op === "http") {
        const request = renderDiscoveryRequest(
          operation.request as DiscoveryRequestTemplate,
          EMPTY_PAGINATION,
        );
        const requestContext = operation.timeoutMs === undefined
          ? context
          : { ...context, timeoutMs: operation.timeoutMs };
        const fetched = await fetchBounded(request, strategy.allowedDomains, requestContext);
        if (!fetched.ok) return [];
        try {
          savedJson.set(operation.saveAs, {
            document: JSON.parse(fetched.response.body),
            baseUrl: fetched.response.url,
          });
        } catch {
          return [];
        }
        continue;
      }

      if (operation.op === "extract") {
        const timeout = operation.timeoutMs ?? context.timeoutMs ?? 10_000;
        if (operation.source === "dom") {
          const links = await withDeadline(
            async () => selectorLinks(
              session.page,
              operation.linkSelectors,
              timeout,
              context.maxDomMatches ?? 1_000,
            ),
            timeout,
          );
          for (const link of links) {
            try {
              if (appendRef({
                canonicalUrl: canonicalizeRetailerUrl(
                  link,
                  session.finalDocumentUrl ?? session.page.url(),
                  strategy.allowedDomains,
                ),
                externalId: null,
                sourceCategory: null,
              })) return refs;
            } catch {
              // Ignore malformed or cross-domain discovered URLs.
            }
          }
        } else {
          const saved = savedJson.get(operation.from);
          if (saved === undefined) return [];
          const discovered = await withDeadline(
            async () => jsonRefs(saved, operation, strategy),
            timeout,
          );
          for (const ref of discovered) {
            if (appendRef(ref)) return refs;
          }
        }
        continue;
      }

      session.deniedUrl = null;
      await withDeadline(
        async () => pageOperation(operation, session.page, strategy, context),
        operation.timeoutMs ?? context.timeoutMs ?? 10_000,
      );
    }
  } catch {
    return [];
  }

  return refs.slice(0, strategy.maxProducts);
}

export async function discoverScript(
  strategy: ScriptDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): Promise<ProductRef[]> {
  if (strategy.operations.length > MAX_OPERATIONS) return [];

  const totalController = new AbortController();
  const totalSignal = context.signal === undefined
    ? totalController.signal
    : AbortSignal.any([totalController.signal, context.signal]);
  const programContext: DiscoveryExecutionContext = {
    ...context,
    signal: totalSignal,
  };

  try {
    return await withRestrictedPage(
      strategy.allowedDomains,
      programContext,
      async (session) => {
        totalSignal.throwIfAborted();
        return withTotalDeadline(
          async () => runDiscoveryProgram(strategy, programContext, session),
          context.totalTimeoutMs ?? MAX_TOTAL_RUNTIME_MS,
          totalController,
          async () => session.page.close(),
        );
      },
    );
  } catch {
    return [];
  }
}
