import { JSONPath } from "jsonpath-plus";
import type { Page } from "playwright";

import {
  assertNavigationAllowed,
  withRestrictedPage,
} from "../collection/browser.js";
import { fetchBounded } from "../collection/http.js";
import { canonicalizeRetailerUrl } from "../normalize/url.js";
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
): Promise<string[]> {
  for (const candidate of selectors) {
    try {
      const locator = page.locator(candidate.selector);
      const count = await locator.count();
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
  const values = JSONPath<unknown[]>({
    path,
    json: document as null | boolean | number | string | object | unknown[],
    resultType: "value",
    wrap: true,
    eval: false,
  });
  if (values.length === 1 && Array.isArray(values[0])) return values[0] as unknown[];
  return values;
}

function jsonValue(document: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  return JSONPath({
    path,
    json: document as null | boolean | number | string | object | unknown[],
    resultType: "value",
    wrap: false,
    eval: false,
  });
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

export async function discoverScript(
  strategy: ScriptDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): Promise<ProductRef[]> {
  if (strategy.operations.length > MAX_OPERATIONS) return [];

  try {
    return await withRestrictedPage(strategy.allowedDomains, context, async (session) => withDeadline(async () => {
      const refs: ProductRef[] = [];
      const savedJson = new Map<string, SavedJson>();

      try {
        for (const operation of strategy.operations) {
          if (session.deniedUrl !== null) return [];

          if (operation.op === "http") {
            const request = renderDiscoveryRequest(
              operation.request as DiscoveryRequestTemplate,
              EMPTY_PAGINATION,
            );
            const requestContext = operation.timeoutMs === undefined
              ? context
              : { ...context, timeoutMs: operation.timeoutMs };
            const fetched = await fetchBounded(
              request,
              strategy.allowedDomains,
              requestContext,
            );
            if (!fetched.ok) return [];
            try {
              savedJson.set(operation.saveAs, {
                document: JSON.parse(fetched.response.body),
                baseUrl: fetched.response.url,
              });
            } catch {
              return [];
            }
            if (session.deniedUrl !== null) return [];
            continue;
          }

          if (operation.op === "extract") {
            const timeout = operation.timeoutMs ?? context.timeoutMs ?? 10_000;
            if (operation.source === "dom") {
              const links = await withDeadline(
                async () => selectorLinks(session.page, operation.linkSelectors, timeout),
                timeout,
              );
              for (const link of links) {
                try {
                  refs.push({
                    canonicalUrl: canonicalizeRetailerUrl(
                      link,
                      session.page.url(),
                      strategy.allowedDomains,
                    ),
                    externalId: null,
                    sourceCategory: null,
                  });
                } catch {
                  // Ignore malformed or cross-domain discovered URLs.
                }
              }
            } else {
              const saved = savedJson.get(operation.from);
              if (saved === undefined) return [];
              refs.push(...await withDeadline(
                async () => jsonRefs(saved, operation, strategy),
                timeout,
              ));
            }
            if (session.deniedUrl !== null) return [];
            if (refs.length >= strategy.maxProducts) return refs.slice(0, strategy.maxProducts);
            continue;
          }

          session.deniedUrl = null;
          await withDeadline(
            async () => pageOperation(operation, session.page, strategy, context),
            operation.timeoutMs ?? context.timeoutMs ?? 10_000,
          );
          if (session.deniedUrl !== null) return [];
        }
      } catch {
        return [];
      }

      return refs.slice(0, strategy.maxProducts);
    }, MAX_TOTAL_RUNTIME_MS));
  } catch {
    return [];
  }
}
