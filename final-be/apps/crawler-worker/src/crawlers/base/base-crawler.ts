import { Logger } from '@nestjs/common';
import {
  ICatalogCrawler,
  CrawlerContext,
  CategoryDiscoveryResult,
  CategoryCrawlResult,
  ProductFetchResult,
  CrawlError,
} from '@app/common';

/**
 * Abstract base class for catalog crawlers.
 * Provides common utilities and enforces the ICatalogCrawler contract.
 *
 * To implement a new merchant crawler:
 * 1. Extend this class
 * 2. Implement all abstract methods
 * 3. Register the crawler in CrawlerRegistry
 */
export abstract class BaseCatalogCrawler implements ICatalogCrawler {
  abstract readonly crawlerId: string;
  abstract readonly displayName: string;
  abstract readonly supportedMerchantIds: bigint[];

  protected readonly logger: Logger;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  // ==========================================================================
  // Abstract methods - must be implemented by subclasses
  // ==========================================================================

  abstract discoverCategories(context: CrawlerContext): Promise<CategoryDiscoveryResult>;

  abstract crawlCategoryPage(
    context: CrawlerContext,
    categoryUrl: string,
    page?: number,
  ): Promise<CategoryCrawlResult>;

  abstract fetchProduct(
    context: CrawlerContext,
    productUrl: string,
  ): Promise<ProductFetchResult>;

  // ==========================================================================
  // Optional methods - can be overridden by subclasses
  // ==========================================================================

  canHandleUrl(url: string): boolean {
    return this.supportedMerchantIds.length > 0;
  }

  async setupSession(_context: CrawlerContext): Promise<void> {
    // Default: no-op, override in subclass if needed
  }

  async teardownSession(_context: CrawlerContext): Promise<void> {
    // Default: no-op, override in subclass if needed
  }

  // ==========================================================================
  // Utility methods for subclasses
  // ==========================================================================

  /**
   * Normalize a URL to absolute
   */
  protected normalizeUrl(url: string, baseUrl: string): string {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    if (url.startsWith('//')) {
      return `https:${url}`;
    }
    if (url.startsWith('/')) {
      // Remove trailing slash from baseUrl if present
      const cleanBase = baseUrl.replace(/\/$/, '');
      return `${cleanBase}${url}`;
    }
    return `${baseUrl}/${url}`;
  }

  /**
   * Create a standard error object
   */
  protected createError(
    type: CrawlError['type'],
    message: string,
    url?: string,
    httpStatus?: number,
  ): CrawlError {
    return { type, message, url, httpStatus };
  }

  /**
   * Extract JSON-LD product data from HTML
   */
  protected extractJsonLd(html: string): Record<string, unknown> | null {
    const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1]);

        // Handle array of schemas
        if (Array.isArray(data)) {
          const product = data.find(
            (item) => item['@type'] === 'Product' || item['@type']?.includes('Product'),
          );
          if (product) return product;
        }

        // Handle single schema
        if (data['@type'] === 'Product' || data['@type']?.includes?.('Product')) {
          return data;
        }

        // Handle @graph structure
        if (data['@graph']) {
          const product = data['@graph'].find(
            (item: Record<string, unknown>) =>
              item['@type'] === 'Product' || (item['@type'] as string[])?.includes?.('Product'),
          );
          if (product) return product;
        }
      } catch {
        // Continue to next match if JSON parse fails
        continue;
      }
    }

    return null;
  }

  /**
   * Extract a value from HTML using a simple regex pattern
   * Useful for extracting data from data attributes or meta tags
   */
  protected extractFromHtml(
    html: string,
    pattern: RegExp,
    groupIndex = 1,
  ): string | undefined {
    const match = html.match(pattern);
    return match?.[groupIndex] || undefined;
  }

  /**
   * Clean up text content (trim, normalize whitespace)
   */
  protected cleanText(text: string | undefined | null): string | undefined {
    if (!text) return undefined;
    return text.replace(/\s+/g, ' ').trim() || undefined;
  }

  /**
   * Parse a price string to a number
   */
  protected parsePrice(priceText: string | undefined | null): number | undefined {
    if (!priceText) return undefined;

    // Remove currency symbols and normalize
    const cleaned = priceText
      .replace(/[R$€£¥]/g, '')
      .replace(/\s/g, '')
      .replace(/\./g, '') // Remove thousand separators (Brazilian format)
      .replace(',', '.'); // Convert decimal separator

    const price = parseFloat(cleaned);
    return isNaN(price) ? undefined : price;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Retry an async operation with exponential backoff
   */
  protected async withRetry<T>(
    operation: () => Promise<T>,
    maxAttempts = 3,
    baseDelayMs = 1000,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxAttempts) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          this.logger.warn(
            `Operation failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${lastError.message}`,
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }
}
