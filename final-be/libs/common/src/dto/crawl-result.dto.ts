/**
 * DTOs for crawl results and API responses
 */

/**
 * Progress statistics for a catalog run
 */
export interface CatalogRunProgress {
  runId: bigint;
  discoveredProducts: number;
  categoriesCrawled: number;
  httpFetches: number;
  failedFetches?: number;
  status?: string;
}

/**
 * Result of product reconciliation after a run
 */
export interface ReconciliationResult {
  runId: bigint;
  productsUpdated: number;
  productsDeactivated: number;
  totalDiscovered: number;
}

/**
 * Parameters for creating a catalog run
 */
export interface CatalogRunParams {
  scheduledBy?: 'weekly-cron' | 'manual';
  weekNumber?: number;
  seeds?: string[];
  limits?: {
    maxCategories?: number;
    maxProducts?: number;
    maxDepth?: number;
  };
}

/**
 * Queue statistics
 */
export interface QueueStats {
  catalog: QueueJobCounts;
  category: QueueJobCounts;
  productFetch: QueueJobCounts;
}

export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

/**
 * Serializable versions for API responses
 */
export interface SerializedCatalogRunProgress {
  runId: string;
  discoveredProducts: number;
  categoriesCrawled: number;
  httpFetches: number;
  failedFetches?: number;
  status?: string;
}

export interface SerializedReconciliationResult {
  runId: string;
  productsUpdated: number;
  productsDeactivated: number;
  totalDiscovered: number;
}

export function serializeRunProgress(progress: CatalogRunProgress): SerializedCatalogRunProgress {
  return {
    ...progress,
    runId: progress.runId.toString(),
  };
}

export function serializeReconciliationResult(
  result: ReconciliationResult,
): SerializedReconciliationResult {
  return {
    ...result,
    runId: result.runId.toString(),
  };
}
