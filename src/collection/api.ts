import type { ApiExtractionStrategy } from "../strategies/schema.js";
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

function parseFailure(message: string, responded: boolean): ExtractionResult {
  return {
    ok: false,
    failure: { category: "parse", message, responded },
  };
}

export async function executeApi(
  strategy: ApiExtractionStrategy,
  ref: ProductRef,
  context: ExtractionExecutionContext = {},
): Promise<ExtractionResult> {
  let request;
  try {
    request = renderRequestTemplate(strategy.request, ref);
  } catch (error) {
    return parseFailure(
      error instanceof Error ? error.message : "Request template rendering failed",
      false,
    );
  }

  const fetched = await fetchBounded(request, strategy.allowedDomains, context);
  if (!fetched.ok) return { ok: false, failure: fetched.failure };

  let document: unknown;
  try {
    document = JSON.parse(fetched.response.body);
  } catch (error) {
    return {
      ok: false,
      failure: {
        category: "parse",
        message: error instanceof Error ? error.message : "Response was not valid JSON",
        responded: true,
        statusCode: fetched.response.status,
      },
    };
  }

  const mapped = mapJsonExtractionFields(document, strategy.fields);
  if (mapped.ok || mapped.failure === undefined) return mapped;
  return {
    ok: false,
    failure: {
      ...mapped.failure,
      statusCode: fetched.response.status,
    },
  };
}
