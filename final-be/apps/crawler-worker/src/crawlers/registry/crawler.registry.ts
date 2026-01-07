import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ICatalogCrawler } from '@app/common';

/**
 * Registry for catalog crawlers.
 *
 * To register a new crawler:
 * 1. Create a class extending BaseCatalogCrawler
 * 2. Import it in this file
 * 3. Instantiate and register it in onModuleInit()
 *
 * Example:
 * ```typescript
 * import { CarrefourCrawler } from '../carrefour/carrefour.crawler';
 *
 * // In onModuleInit():
 * this.registerCrawler(new CarrefourCrawler());
 * ```
 */
@Injectable()
export class CrawlerRegistry implements OnModuleInit {
  private readonly logger = new Logger(CrawlerRegistry.name);

  private crawlersByMerchant = new Map<bigint, ICatalogCrawler>();
  private crawlersById = new Map<string, ICatalogCrawler>();

  async onModuleInit() {
    // Register all available crawlers here
    // Example:
    // this.registerCrawler(new CarrefourCrawler());
    // this.registerCrawler(new PaoDeAcucarCrawler());

    this.logger.log(
      `Crawler registry initialized with ${this.crawlersById.size} crawlers`,
    );

    if (this.crawlersById.size === 0) {
      this.logger.warn(
        'No crawlers registered! Add crawler implementations and register them in CrawlerRegistry.onModuleInit()',
      );
    }
  }

  /**
   * Register a crawler instance
   */
  registerCrawler(crawler: ICatalogCrawler): void {
    this.crawlersById.set(crawler.crawlerId, crawler);

    for (const merchantId of crawler.supportedMerchantIds) {
      if (this.crawlersByMerchant.has(merchantId)) {
        this.logger.warn(
          `Merchant ${merchantId} already has a registered crawler, overwriting with ${crawler.crawlerId}`,
        );
      }
      this.crawlersByMerchant.set(merchantId, crawler);
    }

    this.logger.log(
      `Registered crawler: ${crawler.crawlerId} (${crawler.displayName}) for merchants: ${crawler.supportedMerchantIds.join(', ')}`,
    );
  }

  /**
   * Get crawler for a specific merchant ID
   */
  getCrawlerForMerchant(merchantId: bigint): ICatalogCrawler | undefined {
    return this.crawlersByMerchant.get(merchantId);
  }

  /**
   * Get crawler by ID
   */
  getCrawlerById(crawlerId: string): ICatalogCrawler | undefined {
    return this.crawlersById.get(crawlerId);
  }

  /**
   * Get all registered crawler IDs
   */
  getAllCrawlerIds(): string[] {
    return Array.from(this.crawlersById.keys());
  }

  /**
   * Get all registered crawlers
   */
  getAllCrawlers(): ICatalogCrawler[] {
    return Array.from(this.crawlersById.values());
  }

  /**
   * Check if a crawler exists for a merchant
   */
  hasCrawlerForMerchant(merchantId: bigint): boolean {
    return this.crawlersByMerchant.has(merchantId);
  }

  /**
   * Get supported merchant IDs
   */
  getSupportedMerchantIds(): bigint[] {
    return Array.from(this.crawlersByMerchant.keys());
  }
}
