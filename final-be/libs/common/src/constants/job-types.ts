/**
 * Job types for BullMQ jobs
 */
export const JOB_TYPES = {
  // Catalog orchestration
  START_CATALOG_RUN: 'start-catalog-run',
  COMPLETE_CATALOG_RUN: 'complete-catalog-run',

  // Category crawling
  CRAWL_CATEGORIES: 'crawl-categories',
  CRAWL_CATEGORY_PAGE: 'crawl-category-page',

  // Product fetching
  FETCH_PRODUCT: 'fetch-product',
  FETCH_PRODUCT_BATCH: 'fetch-product-batch',

  // Reconciliation
  RECONCILE_RUN: 'reconcile-run',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
