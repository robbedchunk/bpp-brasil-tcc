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

function expandedJsonLdNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(expandedJsonLdNodes);
  if (!isRecord(value)) return [];

  const graph = value["@graph"];
  if (graph !== undefined) {
    const expandedGraph = expandedJsonLdNodes(graph);
    return expandedGraph.length > 0 ? expandedGraph : [value];
  }
  return [value];
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
      documents.push(JSON.parse(raw));
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

  const expanded = documents.flatMap(expandedJsonLdNodes);
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
  const candidates = extractionCandidates(strategy, parsed.documents);
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
