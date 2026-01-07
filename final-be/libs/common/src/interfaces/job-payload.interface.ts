/**
 * Job payload interfaces for BullMQ jobs
 */

/**
 * Payload for starting a catalog run
 */
export interface CatalogRunJobPayload {
  runId: bigint;
  contextId: bigint;
  merchantId: bigint;
  merchantName: string;
  websiteBaseUrl: string;
  contextParams: Record<string, unknown>;
}

/**
 * Payload for category crawl jobs
 */
export interface CategoryCrawlJobPayload {
  runId: bigint;
  contextId: bigint;
  merchantId: bigint;
  merchantName: string;
  websiteBaseUrl: string;
  contextParams: Record<string, unknown>;
  /** If null/undefined, start from root categories */
  categoryUrl?: string;
  parentCategoryId?: bigint;
  depth?: number;
}

/**
 * Payload for product fetch jobs
 */
export interface ProductFetchJobPayload {
  runId: bigint;
  contextId: bigint;
  productUrl: string;
  categoryId?: bigint;
  priority?: number;
}

/**
 * Payload for reconciliation jobs
 */
export interface ReconciliationJobPayload {
  runId: bigint;
  contextId: bigint;
}

/**
 * Serializable versions of payloads (bigint -> string for JSON)
 */
export interface SerializedCatalogRunJobPayload {
  runId: string;
  contextId: string;
  merchantId: string;
  merchantName: string;
  websiteBaseUrl: string;
  contextParams: Record<string, unknown>;
}

export interface SerializedCategoryCrawlJobPayload {
  runId: string;
  contextId: string;
  merchantId: string;
  merchantName: string;
  websiteBaseUrl: string;
  contextParams: Record<string, unknown>;
  categoryUrl?: string;
  parentCategoryId?: string;
  depth?: number;
}

export interface SerializedProductFetchJobPayload {
  runId: string;
  contextId: string;
  productUrl: string;
  categoryId?: string;
  priority?: number;
}

export interface SerializedReconciliationJobPayload {
  runId: string;
  contextId: string;
}

// =============================================================================
// Serialization Helpers
// =============================================================================

export function serializeCatalogRunPayload(
  payload: CatalogRunJobPayload,
): SerializedCatalogRunJobPayload {
  return {
    ...payload,
    runId: payload.runId.toString(),
    contextId: payload.contextId.toString(),
    merchantId: payload.merchantId.toString(),
  };
}

export function deserializeCatalogRunPayload(
  payload: SerializedCatalogRunJobPayload,
): CatalogRunJobPayload {
  return {
    ...payload,
    runId: BigInt(payload.runId),
    contextId: BigInt(payload.contextId),
    merchantId: BigInt(payload.merchantId),
  };
}

export function serializeCategoryCrawlPayload(
  payload: CategoryCrawlJobPayload,
): SerializedCategoryCrawlJobPayload {
  return {
    ...payload,
    runId: payload.runId.toString(),
    contextId: payload.contextId.toString(),
    merchantId: payload.merchantId.toString(),
    parentCategoryId: payload.parentCategoryId?.toString(),
  };
}

export function deserializeCategoryCrawlPayload(
  payload: SerializedCategoryCrawlJobPayload,
): CategoryCrawlJobPayload {
  return {
    ...payload,
    runId: BigInt(payload.runId),
    contextId: BigInt(payload.contextId),
    merchantId: BigInt(payload.merchantId),
    parentCategoryId: payload.parentCategoryId ? BigInt(payload.parentCategoryId) : undefined,
  };
}

export function serializeProductFetchPayload(
  payload: ProductFetchJobPayload,
): SerializedProductFetchJobPayload {
  return {
    ...payload,
    runId: payload.runId.toString(),
    contextId: payload.contextId.toString(),
    categoryId: payload.categoryId?.toString(),
  };
}

export function deserializeProductFetchPayload(
  payload: SerializedProductFetchJobPayload,
): ProductFetchJobPayload {
  return {
    ...payload,
    runId: BigInt(payload.runId),
    contextId: BigInt(payload.contextId),
    categoryId: payload.categoryId ? BigInt(payload.categoryId) : undefined,
  };
}
