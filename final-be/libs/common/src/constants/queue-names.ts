/**
 * Queue names for BullMQ job queues
 */
export const QUEUE_NAMES = {
  /** Main orchestration queue for catalog runs */
  CATALOG_CRAWL: 'catalog-crawl',
  /** Category page crawling queue */
  CATEGORY_CRAWL: 'category-crawl',
  /** Individual product fetching queue */
  PRODUCT_FETCH: 'product-fetch',
  /** Post-run reconciliation queue */
  RECONCILIATION: 'reconciliation',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
