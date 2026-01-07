import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  QUEUE_NAMES,
  JOB_TYPES,
  SerializedCategoryCrawlJobPayload,
  SerializedProductFetchJobPayload,
  deserializeCategoryCrawlPayload,
  serializeCategoryCrawlPayload,
  serializeProductFetchPayload,
} from '@app/common';
import { CrawlerRegistry } from '../crawlers/registry/crawler.registry';
import { HttpFetchService } from '../services/http-fetch.service';
import {
  CrawlRunRepository,
  MerchantCategoryRepository,
  CatalogDiscoveryRepository,
} from '@app/database';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Processor(QUEUE_NAMES.CATEGORY_CRAWL, {
  concurrency: 5,
  limiter: {
    max: 5,
    duration: 1000,
  },
})
export class CategoryCrawlProcessor extends WorkerHost {
  private readonly logger = new Logger(CategoryCrawlProcessor.name);

  constructor(
    private readonly crawlerRegistry: CrawlerRegistry,
    private readonly httpFetchService: HttpFetchService,
    private readonly crawlRunRepo: CrawlRunRepository,
    private readonly merchantCategoryRepo: MerchantCategoryRepository,
    private readonly catalogDiscoveryRepo: CatalogDiscoveryRepository,
    @InjectQueue(QUEUE_NAMES.CATEGORY_CRAWL)
    private readonly categoryQueue: Queue,
    @InjectQueue(QUEUE_NAMES.PRODUCT_FETCH)
    private readonly productFetchQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<SerializedCategoryCrawlJobPayload>): Promise<void> {
    const payload = deserializeCategoryCrawlPayload(job.data);
    const {
      runId,
      contextId,
      merchantId,
      websiteBaseUrl,
      contextParams,
      categoryUrl,
    } = payload;

    this.logger.log(
      `Processing category crawl job for run ${runId}, category: ${categoryUrl || 'ROOT'}`,
    );

    // Get the appropriate crawler for this merchant
    const crawler = this.crawlerRegistry.getCrawlerForMerchant(merchantId);

    if (!crawler) {
      this.logger.error(`No crawler found for merchant ${merchantId}`);
      throw new Error(`No crawler registered for merchant ${merchantId}`);
    }

    // Build crawler context
    const context = {
      runId,
      contextId,
      merchantId,
      websiteBaseUrl,
      contextParams,
      httpFetchService: this.httpFetchService,
      logger: this.logger,
    };

    if (!categoryUrl) {
      // Initial discovery - get all root categories
      this.logger.log(`Discovering root categories for merchant ${merchantId}`);
      const result = await crawler.discoverCategories(context);

      this.logger.log(`Discovered ${result.categories.length} categories`);

      // Process each discovered category
      for (const category of result.categories) {
        // Upsert category record
        await this.merchantCategoryRepo.upsertCategory(
          contextId,
          runId,
          category.url,
          category.name,
          category.breadcrumb,
        );

        // Enqueue job to crawl this category's products
        await this.categoryQueue.add(
          JOB_TYPES.CRAWL_CATEGORY_PAGE,
          serializeCategoryCrawlPayload({
            ...payload,
            categoryUrl: category.url,
            depth: 0,
          }),
        );
      }

      if (result.errors.length > 0) {
        this.logger.warn(
          `Category discovery had ${result.errors.length} errors`,
          JSON.stringify(result.errors),
        );
      }
    } else {
      // Crawl specific category page
      this.logger.log(`Crawling category page: ${categoryUrl}`);
      const result = await crawler.crawlCategoryPage(context, categoryUrl);

      this.logger.log(
        `Found ${result.products.length} products in category ${categoryUrl}`,
      );

      // Record product discoveries and enqueue fetch jobs
      const fetchJobs: Array<{
        name: string;
        data: SerializedProductFetchJobPayload;
      }> = [];
      for (const product of result.products) {
        // Record discovery
        await this.catalogDiscoveryRepo.upsertDiscovery(
          runId,
          contextId,
          product.url,
        );

        // Prepare fetch job
        fetchJobs.push({
          name: JOB_TYPES.FETCH_PRODUCT,
          data: serializeProductFetchPayload({
            runId,
            contextId,
            productUrl: product.url,
          }),
        });
      }

      // Bulk enqueue product fetch jobs
      if (fetchJobs.length > 0) {
        await this.productFetchQueue.addBulk(fetchJobs);
        this.logger.log(`Enqueued ${fetchJobs.length} product fetch jobs`);
      }

      // Handle pagination
      if (result.nextPageUrl) {
        await this.categoryQueue.add(
          JOB_TYPES.CRAWL_CATEGORY_PAGE,
          serializeCategoryCrawlPayload({
            ...payload,
            categoryUrl: result.nextPageUrl,
          }),
        );
      }

      // Handle subcategories
      for (const subUrl of result.subcategoryUrls) {
        await this.categoryQueue.add(
          JOB_TYPES.CRAWL_CATEGORY_PAGE,
          serializeCategoryCrawlPayload({
            ...payload,
            categoryUrl: subUrl,
            depth: (payload.depth || 0) + 1,
          }),
        );
      }

      if (result.errors.length > 0) {
        this.logger.warn(
          `Category crawl had ${result.errors.length} errors`,
          JSON.stringify(result.errors),
        );
      }
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `Category crawl job ${job.id} failed: ${error.message}`,
      error.stack,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Category crawl job ${job.id} completed`);
  }
}
