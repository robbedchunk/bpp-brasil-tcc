import { JSONPath } from "jsonpath-plus";

import { canonicalizeRetailerUrl } from "../normalize/url.js";
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

interface PaginationValues {
  page: string;
  pageSize: string;
  offset: string;
  from: string;
  to: string;
  cursor: string;
}

const PLACEHOLDER = /\{(page|pageSize|offset|from|to|cursor)\}/gu;

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

function jsonPathValues(document: unknown, path: string): unknown[] {
  const result = JSONPath({ path, json: document as object, resultType: "value" });
  if (!Array.isArray(result)) return result === undefined ? [] : [result];
  if (result.length === 1 && Array.isArray(result[0])) return result[0] as unknown[];
  return result as unknown[];
}

function jsonPathValue(document: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  return JSONPath({
    path,
    json: document as object,
    resultType: "value",
    wrap: false,
  });
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const rendered = String(value).trim();
  return rendered.length === 0 ? null : rendered;
}

function productRef(
  item: unknown,
  strategy: ApiDiscoveryStrategy,
  baseUrl: string,
): ProductRef | null {
  const rawUrl = jsonPathValue(item, strategy.refFields.url);
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) return null;
  try {
    return {
      canonicalUrl: canonicalizeRetailerUrl(rawUrl, baseUrl, strategy.allowedDomains),
      externalId: optionalString(jsonPathValue(item, strategy.refFields.externalId)),
      sourceCategory: optionalString(jsonPathValue(item, strategy.refFields.sourceCategory)),
    };
  } catch {
    return null;
  }
}

function valuesFor(
  strategy: ApiDiscoveryStrategy,
  attempt: number,
  cursor: string | null,
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
    };
  }
  return {
    page: String(attempt),
    pageSize: "",
    offset: "",
    from: "",
    to: "",
    cursor: cursor ?? "",
  };
}

export async function* discoverApi(
  strategy: ApiDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): AsyncGenerator<ProductRef> {
  const seenCursors = new Set<string>();
  let cursor = strategy.pagination.kind === "cursor"
    ? strategy.pagination.initial
    : null;
  let produced = 0;

  for (let attempt = 0; attempt < strategy.pagination.maxPages; attempt += 1) {
    const request = renderDiscoveryRequest(strategy.request, valuesFor(strategy, attempt, cursor));
    const fetched = await fetchBounded(request, strategy.allowedDomains, context);
    if (!fetched.ok) return;

    let document: unknown;
    try {
      document = JSON.parse(fetched.response.body);
    } catch {
      return;
    }
    const items = jsonPathValues(document, strategy.itemsPath);
    if (items.length === 0) return;

    for (const item of items) {
      const ref = productRef(item, strategy, fetched.response.url || request.url);
      if (ref === null) continue;
      yield ref;
      produced += 1;
      if (produced >= strategy.maxProducts) return;
    }

    if (strategy.pagination.kind === "cursor") {
      const next = optionalString(jsonPathValue(document, strategy.pagination.nextCursorPath));
      if (next === null || seenCursors.has(next)) return;
      seenCursors.add(next);
      cursor = next;
    } else if (
      strategy.pagination.kind === "offset" &&
      items.length < strategy.pagination.pageSize
    ) {
      return;
    }
  }
}
