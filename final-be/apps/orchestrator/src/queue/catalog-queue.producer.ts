import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import {
  QUEUE_NAMES,
  JOB_TYPES,
  SerializedCatalogRunJobPayload,
  SerializedCategoryCrawlJobPayload,
  SerializedProductFetchJobPayload,
  SerializedReconciliationJobPayload,
  QueueStats,
  QueueJobCounts,
} from '@app/common';

@Injectable()
export class CatalogQueueProducer {
  private readonly logger = new Logger(CatalogQueueProducer.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.CATALOG_CRAWL)
    private readonly catalogQueue: Queue,
    @InjectQueue(QUEUE_NAMES.CATEGORY_CRAWL)
    private readonly categoryQueue: Queue,
    @InjectQueue(QUEUE_NAMES.PRODUCT_FETCH)
    private readonly productFetchQueue: Queue,
    @InjectQueue(QUEUE_NAMES.RECONCILIATION)
    private readonly reconciliationQueue: Queue,
  ) {}

  /**
   * Enqueue initial category crawl job (discovers all categories)
   */
  async enqueueCategoryCrawl(
    payload: SerializedCatalogRunJobPayload,
  ): Promise<Job> {
    this.logger.log(
      `Enqueueing category crawl for run ${payload.runId}, merchant ${payload.merchantName}`,
    );

    return this.categoryQueue.add(
      JOB_TYPES.CRAWL_CATEGORIES,
      {
        ...payload,
        categoryUrl: undefined, // null means discover root categories
        depth: 0,
      } as SerializedCategoryCrawlJobPayload,
      {
        jobId: `crawl-categories-${payload.runId}`,
      },
    );
  }

  /**
   * Enqueue a specific category page crawl
   */
  async enqueueCategoryPageCrawl(
    payload: SerializedCategoryCrawlJobPayload,
  ): Promise<Job> {
    return this.categoryQueue.add(JOB_TYPES.CRAWL_CATEGORY_PAGE, payload);
  }

  /**
   * Enqueue product fetch jobs in bulk
   */
  async enqueueProductFetches(
    runId: string,
    contextId: string,
    productUrls: Array<{ url: string; categoryId?: string }>,
  ): Promise<void> {
    this.logger.log(
      `Enqueueing ${productUrls.length} product fetches for run ${runId}`,
    );

    const jobs = productUrls.map((product) => ({
      name: JOB_TYPES.FETCH_PRODUCT,
      data: {
        runId,
        contextId,
        productUrl: product.url,
        categoryId: product.categoryId,
      } as SerializedProductFetchJobPayload,
    }));

    await this.productFetchQueue.addBulk(jobs);
  }

  /**
   * Enqueue a single product fetch job
   */
  async enqueueProductFetch(
    payload: SerializedProductFetchJobPayload,
  ): Promise<Job> {
    return this.productFetchQueue.add(JOB_TYPES.FETCH_PRODUCT, payload);
  }

  /**
   * Enqueue reconciliation job after run completion
   */
  async enqueueReconciliation(
    payload: SerializedReconciliationJobPayload,
  ): Promise<Job> {
    this.logger.log(`Enqueueing reconciliation for run ${payload.runId}`);

    return this.reconciliationQueue.add(JOB_TYPES.RECONCILE_RUN, payload, {
      jobId: `reconcile-${payload.runId}`,
    });
  }

  /**
   * Get statistics for all queues
   */
  async getQueueStats(): Promise<QueueStats> {
    const [catalogCounts, categoryCounts, productCounts] = await Promise.all([
      this.catalogQueue.getJobCounts(),
      this.categoryQueue.getJobCounts(),
      this.productFetchQueue.getJobCounts(),
    ]);

    return {
      catalog: catalogCounts as unknown as QueueJobCounts,
      category: categoryCounts as unknown as QueueJobCounts,
      productFetch: productCounts as unknown as QueueJobCounts,
    };
  }

  /**
   * Pause all queues
   */
  async pauseAllQueues(): Promise<void> {
    await Promise.all([
      this.catalogQueue.pause(),
      this.categoryQueue.pause(),
      this.productFetchQueue.pause(),
      this.reconciliationQueue.pause(),
    ]);
    this.logger.log('All queues paused');
  }

  /**
   * Resume all queues
   */
  async resumeAllQueues(): Promise<void> {
    await Promise.all([
      this.catalogQueue.resume(),
      this.categoryQueue.resume(),
      this.productFetchQueue.resume(),
      this.reconciliationQueue.resume(),
    ]);
    this.logger.log('All queues resumed');
  }
}
