/**
 * Crawler interfaces - Contract for merchant-specific crawler implementations
 */

// =============================================================================
// Result Types
// =============================================================================

/**
 * Result from discovering categories on a merchant's website
 */
export interface CategoryDiscoveryResult {
  categories: DiscoveredCategory[];
  errors: CrawlError[];
}

export interface DiscoveredCategory {
  url: string;
  name: string;
  breadcrumb: string[];
  parentUrl?: string;
  hasSubcategories: boolean;
  productCount?: number;
}

/**
 * Result from crawling a single category page
 */
export interface CategoryCrawlResult {
  categoryUrl: string;
  products: DiscoveredProduct[];
  nextPageUrl?: string;
  subcategoryUrls: string[];
  errors: CrawlError[];
}

export interface DiscoveredProduct {
  url: string;
  sourceProductId?: string;
  gtin?: string;
  name?: string;
  thumbnailUrl?: string;
}

/**
 * Result from fetching a single product page
 */
export interface ProductFetchResult {
  productUrl: string;
  fetchId: bigint;
  success: boolean;
  product?: ParsedProduct;
  error?: CrawlError;
}

export interface ParsedProduct {
  sourceProductId?: string;
  gtin?: string;
  name: string;
  brand?: string;
  description?: string;
  categoryBreadcrumb: string[];
  packageSizeText?: string;
  imageUrls: string[];
  attributes: Record<string, unknown>;
  rawProductJson?: Record<string, unknown>;
}

export interface CrawlError {
  type: 'network' | 'blocked' | 'parse' | 'timeout' | 'unknown';
  message: string;
  url?: string;
  httpStatus?: number;
}

// =============================================================================
// Crawler Context
// =============================================================================

/**
 * Context passed to crawler methods with all necessary information
 */
export interface CrawlerContext {
  runId: bigint;
  contextId: bigint;
  merchantId: bigint;
  websiteBaseUrl: string;
  contextParams: Record<string, unknown>;

  // Services injected by the worker
  httpFetchService: IHttpFetchService;
  logger: ILogger;
}

// =============================================================================
// Service Interfaces
// =============================================================================

/**
 * HTTP fetch service interface for crawlers to use
 */
export interface IHttpFetchService {
  fetch(runId: bigint, url: string, options?: FetchOptions): Promise<FetchResponse>;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  followRedirects?: boolean;
}

export interface FetchResponse {
  fetchId: bigint;
  url: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  body: string;
  bodyStorageKey?: string;
  bodySha256?: Buffer;
  durationMs: number;
  isBlocked: boolean;
}

export interface ILogger {
  log(message: string, context?: string): void;
  warn(message: string, context?: string): void;
  error(message: string, trace?: string, context?: string): void;
  debug(message: string, context?: string): void;
}

// =============================================================================
// Main Crawler Interface
// =============================================================================

/**
 * The main crawler interface that all merchant-specific crawlers must implement.
 * This is the contract between the orchestrator and crawler implementations.
 */
export interface ICatalogCrawler {
  /**
   * Unique identifier for this crawler (e.g., 'carrefour-br', 'paodeacucar-br')
   */
  readonly crawlerId: string;

  /**
   * Human-readable name
   */
  readonly displayName: string;

  /**
   * Supported merchant IDs in the database
   */
  readonly supportedMerchantIds: bigint[];

  /**
   * Discover all top-level categories from the merchant's website.
   * This is typically called once at the start of a catalog run.
   */
  discoverCategories(context: CrawlerContext): Promise<CategoryDiscoveryResult>;

  /**
   * Crawl a specific category page and extract product URLs.
   * Should handle pagination internally or return nextPageUrl for orchestrator to handle.
   */
  crawlCategoryPage(
    context: CrawlerContext,
    categoryUrl: string,
    page?: number,
  ): Promise<CategoryCrawlResult>;

  /**
   * Fetch and parse a single product page.
   */
  fetchProduct(context: CrawlerContext, productUrl: string): Promise<ProductFetchResult>;

  /**
   * Optional: Check if the crawler can handle a specific URL pattern.
   * Useful for URL-based routing in multi-crawler setups.
   */
  canHandleUrl?(url: string): boolean;

  /**
   * Optional: Get any required cookies or session setup.
   * Called before starting a crawl run.
   */
  setupSession?(context: CrawlerContext): Promise<void>;

  /**
   * Optional: Cleanup after a crawl run completes.
   */
  teardownSession?(context: CrawlerContext): Promise<void>;
}
