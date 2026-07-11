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
import { attachPrivateReplay } from "./private-replay.js";

function parseFailure(message: string, responded: boolean): ExtractionResult {
  return {
    ok: false,
    failure: { category: "parse", message, responded },
  };
}

function applyRegionalContext(
  request: ReturnType<typeof renderRequestTemplate>,
  strategy: ApiExtractionStrategy,
): ReturnType<typeof renderRequestTemplate> {
  if (strategy.regionalContext === undefined) return request;
  const payload = {
    campaigns: null,
    channel: strategy.regionalContext.salesChannel,
    priceTables: null,
    regionId: strategy.regionalContext.regionId,
    utm_campaign: null,
    utm_source: null,
    utmi_campaign: null,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return {
    ...request,
    headers: {
      ...request.headers,
      cookie: `vtex_segment=${encoded}`,
    },
  };
}

type SellerBindingResult =
  | { ok: true; document: unknown }
  | { ok: false; result: ExtractionResult };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function bindRegionalCatalogSeller(
  document: unknown,
  strategy: ApiExtractionStrategy,
  ref: ProductRef,
): SellerBindingResult {
  const expectedSellerId = strategy.regionalContext?.catalogSellerId;
  if (expectedSellerId === undefined) return { ok: true, document };
  const products = Array.isArray(document) ? document : null;
  const product = objectValue(products?.[0]);
  const returnedProductId = product?.productId;
  const items = Array.isArray(product?.items) ? product.items : null;
  const firstItem = objectValue(items?.[0]);
  const sellers = Array.isArray(firstItem?.sellers) ? firstItem.sellers : null;
  const matchingSellerIndexes = sellers?.flatMap((value, index) =>
    objectValue(value)?.sellerId === expectedSellerId ? [index] : []) ?? [];
  if (
    products === null
    || products.length !== 1
    || product === null
    || ref.externalId === null
    || typeof returnedProductId !== "string"
    || returnedProductId !== ref.externalId
    || items === null
    || firstItem === null
    || sellers === null
    || matchingSellerIndexes.length !== 1
  ) {
    const reason = products !== null
      && products.length === 1
      && product !== null
      && ref.externalId !== null
      && typeof returnedProductId === "string"
      && returnedProductId === ref.externalId
      ? `seller ${expectedSellerId} did not occur exactly once`
      : `response product identity did not match ${ref.externalId ?? "a non-null external ID"}`;
    return {
      ok: false,
      result: {
        ok: false,
        failure: {
          category: "missing-fields",
          message: `Validated regional binding failed: ${reason}`,
          responded: true,
        },
      },
    };
  }
  const selectedIndex = matchingSellerIndexes[0];
  if (selectedIndex === undefined) {
    return {
      ok: false,
      result: parseFailure("Regional seller selection was unexpectedly empty", true),
    };
  }
  const selected = sellers[selectedIndex];
  const boundItem = {
    ...firstItem,
    sellers: [selected, ...sellers.filter((_value, index) => index !== selectedIndex)],
  };
  return {
    ok: true,
    document: [
      { ...product, items: [boundItem, ...items.slice(1)] },
      ...products.slice(1),
    ],
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

  const fetched = await fetchBounded(
    applyRegionalContext(request, strategy),
    strategy.allowedDomains,
    context,
  );
  if (!fetched.ok) return { ok: false, failure: fetched.failure };
  const replay = {
    body: fetched.response.body,
    mediaType: "application/json" as const,
  };

  let document: unknown;
  try {
    document = JSON.parse(fetched.response.body);
  } catch (error) {
    return attachPrivateReplay({
      ok: false,
      failure: {
        category: "parse",
        message: error instanceof Error ? error.message : "Response was not valid JSON",
        responded: true,
        statusCode: fetched.response.status,
      },
    }, replay);
  }

  const sellerBound = bindRegionalCatalogSeller(document, strategy, ref);
  if (!sellerBound.ok) {
    const failure = sellerBound.result.failure;
    if (failure === undefined) return sellerBound.result;
    return attachPrivateReplay({
      ok: false,
      failure: { ...failure, statusCode: fetched.response.status },
    }, replay);
  }

  const mapped = mapJsonExtractionFields(sellerBound.document, strategy.fields);
  if (mapped.ok || mapped.failure === undefined) {
    return attachPrivateReplay({ ...mapped }, replay);
  }
  return attachPrivateReplay({
    ok: false,
    failure: {
      ...mapped.failure,
      statusCode: fetched.response.status,
    },
  }, replay);
}
