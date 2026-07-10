import { load } from "cheerio";

import type { EmbeddedJsonExtractionStrategy } from "../strategies/schema.js";
import type {
  ExtractionResult,
  ProductRef,
} from "../strategies/types.js";
import { mapJsonExtractionFields } from "./field-map.js";
import {
  fetchBounded,
  renderRequestTemplate,
  type ExtractionExecutionContext,
} from "./http.js";

const MAX_JSON_LD_DEPTH = 64;
const MAX_JSON_LD_NODES = 10_000;

function failure(
  message: string,
  responded: boolean,
  statusCode?: number,
  html?: string,
): ExtractionResult {
  return {
    ok: false,
    failure: statusCode === undefined
      ? { category: "parse", message, responded }
      : { category: "parse", message, responded, statusCode },
    ...(html === undefined ? {} : { html }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expandedJsonLdNodes(values: unknown[]): unknown[] {
  if (values.length > MAX_JSON_LD_NODES) {
    throw new Error(`Embedded JSON-LD exceeds ${MAX_JSON_LD_NODES} nodes before enqueue`);
  }
  const stack = values
    .map((value) => ({ value, depth: 0 }))
    .reverse();
  const expanded: unknown[] = [];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    visited += 1;
    if (visited > MAX_JSON_LD_NODES) {
      throw new Error(`Embedded JSON-LD exceeds ${MAX_JSON_LD_NODES} nodes`);
    }
    if (current.depth > MAX_JSON_LD_DEPTH) {
      throw new Error(`Embedded JSON-LD exceeds depth ${MAX_JSON_LD_DEPTH}`);
    }
    if (Array.isArray(current.value)) {
      if (visited + stack.length + current.value.length > MAX_JSON_LD_NODES) {
        throw new Error(
          `Embedded JSON-LD exceeds ${MAX_JSON_LD_NODES} nodes before enqueue`,
        );
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) continue;

    const graph = current.value["@graph"];
    if (graph === undefined) {
      expanded.push(current.value);
    } else {
      if (visited + stack.length + 1 > MAX_JSON_LD_NODES) {
        throw new Error(
          `Embedded JSON-LD exceeds ${MAX_JSON_LD_NODES} nodes before enqueue`,
        );
      }
      stack.push({ value: graph, depth: current.depth + 1 });
    }
  }
  return expanded;
}

function isProductNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = value["@type"];
  if (typeof type === "string") return type.toLowerCase() === "product";
  return Array.isArray(type)
    && type.some(
      (entry) => typeof entry === "string" && entry.toLowerCase() === "product",
    );
}

function parseDocuments(rawDocuments: string[]): {
  documents: unknown[];
  errors: string[];
} {
  const documents: unknown[] = [];
  const errors: string[] = [];
  for (const raw of rawDocuments) {
    try {
      const trimmed = raw.trim();
      const remixPrefix = "window.__remixContext =";
      const json = trimmed.startsWith(remixPrefix)
        ? trimmed.slice(remixPrefix.length).trim().replace(/;\s*$/u, "")
        : trimmed;
      documents.push(JSON.parse(json));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Embedded JSON is invalid");
    }
  }
  return { documents, errors };
}

function locateRawDocuments(
  strategy: EmbeddedJsonExtractionStrategy,
  html: string,
): string[] {
  const $ = load(html);
  if (strategy.source.kind === "json-ld") {
    return $("script")
      .filter((_index, element) => {
        const type = $(element).attr("type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        return type === "application/ld+json";
      })
      .toArray()
      .map((element) => $(element).text().trim())
      .filter((text) => text.length > 0);
  }

  const selector = strategy.source.kind === "next-data"
    ? "script#__NEXT_DATA__"
    : strategy.source.selector;
  return $(selector)
    .filter((_index, element) => $(element).is("script"))
    .toArray()
    .map((element) => $(element).text().trim())
    .filter((text) => text.length > 0);
}

function extractionCandidates(
  strategy: EmbeddedJsonExtractionStrategy,
  documents: unknown[],
): unknown[] {
  if (strategy.source.kind !== "json-ld") return documents;

  const expanded = expandedJsonLdNodes(documents);
  const products = expanded.filter(isProductNode);
  return products.length > 0 ? products : expanded;
}

export async function executeEmbeddedJson(
  strategy: EmbeddedJsonExtractionStrategy,
  ref: ProductRef,
  context: ExtractionExecutionContext = {},
): Promise<ExtractionResult> {
  let request;
  try {
    request = renderRequestTemplate(strategy.request, ref);
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Request template rendering failed",
      false,
    );
  }

  const fetched = await fetchBounded(request, strategy.allowedDomains, context);
  if (!fetched.ok) return { ok: false, failure: fetched.failure };

  let rawDocuments: string[];
  try {
    rawDocuments = locateRawDocuments(strategy, fetched.response.body);
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Embedded script selector is invalid",
      true,
      fetched.response.status,
      fetched.response.body,
    );
  }

  if (rawDocuments.length === 0) {
    return failure(
      `No embedded JSON scripts matched source ${strategy.source.kind}`,
      true,
      fetched.response.status,
      fetched.response.body,
    );
  }

  const parsed = parseDocuments(rawDocuments);
  let candidates: unknown[];
  try {
    candidates = extractionCandidates(strategy, parsed.documents);
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Embedded JSON traversal failed",
      true,
      fetched.response.status,
      fetched.response.body,
    );
  }
  if (candidates.length === 0) {
    const details = parsed.errors[0] ?? "Embedded JSON contained no objects";
    return failure(
      details,
      true,
      fetched.response.status,
      fetched.response.body,
    );
  }

  let firstMappingFailure: ExtractionResult | undefined;
  for (const candidate of candidates) {
    const mapped = mapJsonExtractionFields(candidate, strategy.fields);
    if (mapped.ok) {
      return { ...mapped, html: fetched.response.body };
    }
    firstMappingFailure ??= mapped;
  }

  if (firstMappingFailure?.failure !== undefined) {
    return {
      ok: false,
      failure: {
        ...firstMappingFailure.failure,
        statusCode: fetched.response.status,
      },
      html: fetched.response.body,
    };
  }
  return failure(
    "Embedded JSON fields could not be mapped",
    true,
    fetched.response.status,
    fetched.response.body,
  );
}
