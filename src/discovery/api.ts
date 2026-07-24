import { createHash } from "node:crypto";

import { canonicalizeRetailerUrl } from "../normalize/url.js";
import {
  safeJsonPathValue,
  safeJsonPathValues,
} from "../strategies/json-path.js";
import type {
  ApiDiscoveryStrategy,
  DiscoveryRequestTemplate,
  JsonTemplateValue,
} from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import {
  fetchBounded,
  type BoundedHttpRequest,
} from "../collection/http.js";
import type { DiscoveryExecutionContext } from "./executor.js";
import { DiscoveryFailureError } from "./failure.js";

interface PaginationValues {
  page: string;
  pageSize: string;
  offset: string;
  from: string;
  to: string;
  cursor: string;
  segment: string;
}

const PLACEHOLDER = /\{(page|pageSize|offset|from|to|cursor|segment)\}/gu;

function renderString(template: string, values: PaginationValues): string {
  return template.replace(PLACEHOLDER, (_match, name: keyof PaginationValues) => values[name]);
}

function renderUrlString(template: string, values: PaginationValues): string {
  return template.replace(
    PLACEHOLDER,
    (_match, name: keyof PaginationValues) => encodeURIComponent(values[name]),
  );
}

function renderJson(value: JsonTemplateValue, values: PaginationValues): JsonTemplateValue {
  if (typeof value === "string") return renderString(value, values);
  if (Array.isArray(value)) return value.map((entry) => renderJson(entry, values));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, renderJson(entry, values)]),
    );
  }
  return value;
}

function queryValue(value: JsonTemplateValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function renderDiscoveryRequest(
  template: DiscoveryRequestTemplate,
  values: PaginationValues,
): BoundedHttpRequest {
  const renderedUrl = renderUrlString(template.url, values);
  const url = new URL(renderedUrl);
  if (template.query !== undefined) {
    const query = renderJson(template.query, values) as Record<string, JsonTemplateValue>;
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, queryValue(value));
    }
  }

  const headers = Object.fromEntries(
    Object.entries(template.headers).map(([name, value]) => [
      name,
      renderString(value, values),
    ]),
  );
  if (template.body === undefined) {
    return { url: url.toString(), method: template.method, headers };
  }
  return {
    url: url.toString(),
    method: template.method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(renderJson(template.body, values)),
  };
}

function itemArray(document: unknown, path: string): unknown[] | null {
  const wildcardMatch = /^(.*)\[\*\]$/u.exec(path);
  if (wildcardMatch !== null) {
    const containerPath = wildcardMatch[1];
    if (containerPath === undefined || containerPath.length === 0) return null;
    const container = safeJsonPathValue(document, containerPath);
    return Array.isArray(container) ? container : null;
  }
  const result = safeJsonPathValues(document, path);
  if (result.length !== 1 || !Array.isArray(result[0])) return null;
  return result[0] as unknown[];
}

function jsonPathValue(document: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  return safeJsonPathValue(document, path);
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const rendered = String(value).trim();
  return rendered.length === 0 ? null : rendered;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function productRef(
  item: unknown,
  strategy: ApiDiscoveryStrategy,
  baseUrl: string,
  sourceCategory: string | undefined,
): ProductRef | null {
  const rawUrl = jsonPathValue(item, strategy.refFields.url);
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) return null;
  try {
    return {
      canonicalUrl: canonicalizeRetailerUrl(rawUrl, baseUrl, strategy.allowedDomains),
      externalId: optionalString(jsonPathValue(item, strategy.refFields.externalId)),
      sourceCategory: sourceCategory
        ?? optionalString(jsonPathValue(item, strategy.refFields.sourceCategory)),
    };
  } catch {
    return null;
  }
}

function valuesFor(
  strategy: ApiDiscoveryStrategy,
  attempt: number,
  cursor: string | null,
  segment: string,
): PaginationValues {
  if (strategy.pagination.kind === "page") {
    const page = strategy.pagination.start + attempt * strategy.pagination.step;
    const offset = attempt * strategy.pagination.pageSize;
    return {
      page: String(page),
      pageSize: String(strategy.pagination.pageSize),
      offset: String(offset),
      from: String(offset),
      to: String(offset + strategy.pagination.pageSize - 1),
      cursor: "",
      segment,
    };
  }
  if (strategy.pagination.kind === "offset") {
    const offset = strategy.pagination.start + attempt * strategy.pagination.step;
    return {
      page: String(attempt),
      pageSize: String(strategy.pagination.pageSize),
      offset: String(offset),
      from: String(offset),
      to: String(offset + strategy.pagination.pageSize - 1),
      cursor: "",
      segment,
    };
  }
  return {
    page: String(attempt),
    pageSize: "",
    offset: "",
    from: "",
    to: "",
    cursor: cursor ?? "",
    segment,
  };
}

function requestFingerprint(request: BoundedHttpRequest): string {
  return JSON.stringify({
    method: request.method,
    url: request.url,
    headers: Object.entries(request.headers ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)),
    body: request.body === undefined || request.body === null
      ? null
      : String(request.body),
  });
}

function responseFingerprint(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export async function* discoverApi(
  strategy: ApiDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): AsyncGenerator<ProductRef> {
  const seenProducts = new Set<string>();
  let produced = 0;
  let incompleteReason:
    | "product_cap_reached"
    | "page_cap_reached"
    | "loop_guard_triggered"
    | null = null;
  const segments = strategy.segments ?? [{
    value: "",
    maxProducts: strategy.maxProducts,
  }];

  for (const segment of segments) {
    const seenCursors = new Set<string>();
    const seenRequests = new Set<string>();
    const seenResponses = new Set<string>();
    let cursor = strategy.pagination.kind === "cursor"
      ? strategy.pagination.initial
      : null;
    let segmentProduced = 0;
    let segmentExhausted = false;
    let segmentIncomplete:
      | "product_cap_reached"
      | "page_cap_reached"
      | "loop_guard_triggered"
      | null = null;

    pageLoop: for (
      let attempt = 0;
      attempt < strategy.pagination.maxPages;
      attempt += 1
    ) {
      const request = renderDiscoveryRequest(
        strategy.request,
        valuesFor(strategy, attempt, cursor, segment.value),
      );
      const requestKey = requestFingerprint(request);
      if (seenRequests.has(requestKey)) {
        segmentIncomplete = "loop_guard_triggered";
        break;
      }
      seenRequests.add(requestKey);
      await context.beforeRequest?.();
      const fetched = await fetchBounded(request, strategy.allowedDomains, context);
      if (!fetched.ok) throw new DiscoveryFailureError(fetched.failure);
      const responseKey = responseFingerprint(fetched.response.body);
      if (seenResponses.has(responseKey)) {
        segmentIncomplete = "loop_guard_triggered";
        break;
      }
      seenResponses.add(responseKey);

      let document: unknown;
      try {
        document = JSON.parse(fetched.response.body);
      } catch (error) {
        throw new DiscoveryFailureError({
          category: "parse",
          message: "Discovery response was not valid JSON",
          responded: true,
          statusCode: fetched.response.status,
        }, { cause: error });
      }
      const items = itemArray(document, strategy.itemsPath);
      if (items === null) {
        throw new DiscoveryFailureError({
          category: "parse",
          message: `Discovery items path ${strategy.itemsPath} was missing or not an array`,
          responded: true,
          statusCode: fetched.response.status,
        });
      }
      if (items.length === 0) {
        segmentExhausted = true;
        break;
      }

      let validItems = 0;
      for (const item of items) {
        const ref = productRef(
          item,
          strategy,
          fetched.response.url || request.url,
          segment.sourceCategory,
        );
        if (ref === null) continue;
        validItems += 1;
        if (seenProducts.has(ref.canonicalUrl)) continue;
        seenProducts.add(ref.canonicalUrl);
        yield ref;
        produced += 1;
        segmentProduced += 1;
        if (produced >= strategy.maxProducts) {
          context.reportCompletion?.({ complete: false, reason: "product_cap_reached" });
          return;
        }
        if (segmentProduced >= segment.maxProducts) {
          segmentIncomplete = "product_cap_reached";
          break pageLoop;
        }
      }
      if (validItems === 0) {
        throw new DiscoveryFailureError({
          category: "parse",
          message: "Discovery page contained no valid product references",
          responded: true,
          statusCode: fetched.response.status,
        });
      }

      if (strategy.pagination.kind === "cursor") {
        const next = optionalString(jsonPathValue(document, strategy.pagination.nextCursorPath));
        if (next === null) {
          segmentExhausted = true;
          break;
        }
        if (seenCursors.has(next)) {
          segmentIncomplete = "loop_guard_triggered";
          break;
        }
        seenCursors.add(next);
        cursor = next;
      } else if (strategy.pagination.kind === "page") {
        if (strategy.pagination.pageCountPath === undefined) {
          if (items.length < strategy.pagination.pageSize) {
            segmentExhausted = true;
            break;
          }
        } else {
          const pageCount = positiveInteger(jsonPathValue(
            document,
            strategy.pagination.pageCountPath,
          ));
          if (pageCount === null) {
            throw new DiscoveryFailureError({
              category: "parse",
              message: `Discovery page count path ${strategy.pagination.pageCountPath} was not a positive integer`,
              responded: true,
              statusCode: fetched.response.status,
            });
          }
          if (attempt + 1 >= pageCount) {
            segmentExhausted = true;
            break;
          }
        }
      } else if (items.length < strategy.pagination.pageSize) {
        segmentExhausted = true;
        break;
      }
    }
    if (!segmentExhausted && segmentIncomplete === null) {
      segmentIncomplete = "page_cap_reached";
    }
    incompleteReason ??= segmentIncomplete;
  }
  if (produced === 0) {
    throw new DiscoveryFailureError({
      category: "parse",
      message: "Discovery completed without any valid product references",
      responded: true,
    });
  }
  context.reportCompletion?.(incompleteReason === null
    ? { complete: true, reason: "source_exhausted" }
    : { complete: false, reason: incompleteReason });
}
