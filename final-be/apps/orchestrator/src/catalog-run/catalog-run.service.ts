import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CrawlRunRepository,
  CatalogDiscoveryRepository,
  MerchantCategoryRepository,
  HttpFetchRepository,
} from '@app/database';
import { CatalogQueueProducer } from '../queue/catalog-queue.producer';
import {
  CatalogRunParams,
  CatalogRunProgress,
  serializeCatalogRunPayload,
} from '@app/common';

@Injectable()
export class CatalogRunService {
  private readonly logger = new Logger(CatalogRunService.name);

  constructor(
    private readonly crawlRunRepo: CrawlRunRepository,
    private readonly catalogDiscoveryRepo: CatalogDiscoveryRepository,
    private readonly merchantCategoryRepo: MerchantCategoryRepository,
    private readonly httpFetchRepo: HttpFetchRepository,
    private readonly queueProducer: CatalogQueueProducer,
  ) {}

  /**
   * Create a new catalog run for a merchant context
   */
  async createCatalogRun(contextId: bigint, params?: CatalogRunParams) {
    const run = await this.crawlRunRepo.createCatalogRun(contextId, params);
    this.logger.log(`Created catalog run ${run.runId} for context ${contextId}`);
    return run;
  }

  /**
   * Start the catalog crawl by enqueueing initial jobs
   */
  async startCatalogCrawl(runId: bigint): Promise<void> {
    const run = await this.crawlRunRepo.findByIdWithContext(runId);

    if (!run) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    const { context } = run;
    const { merchant } = context;

    // Enqueue the initial category discovery job
    await this.queueProducer.enqueueCategoryCrawl(
      serializeCatalogRunPayload({
        runId: run.runId,
        contextId: context.contextId,
        merchantId: merchant.merchantId,
        merchantName: merchant.name,
        websiteBaseUrl: merchant.websiteBaseUrl || '',
        contextParams: context.contextParams as Record<string, unknown>,
      }),
    );

    this.logger.log(`Started catalog crawl for run ${runId}`);
  }

  /**
   * Update run status
   */
  async updateRunStatus(
    runId: bigint,
    status: 'running' | 'succeeded' | 'failed' | 'partial',
    notes?: string,
  ) {
    return this.crawlRunRepo.updateStatus(runId, status, notes);
  }

  /**
   * Get run progress statistics
   */
  async getRunProgress(runId: bigint): Promise<CatalogRunProgress> {
    const run = await this.crawlRunRepo.findById(runId);
    if (!run) {
      throw new NotFoundException(`Run ${runId} not found`);
    }

    const [discoveries, categories, fetches, failedFetches] = await Promise.all([
      this.catalogDiscoveryRepo.countDiscoveriesForRun(runId),
      this.merchantCategoryRepo.countCategoriesForRun(runId),
      this.httpFetchRepo.countFetchesForRun(runId),
      this.httpFetchRepo.countFailedFetchesForRun(runId),
    ]);

    return {
      runId,
      discoveredProducts: discoveries,
      categoriesCrawled: categories,
      httpFetches: fetches,
      failedFetches,
      status: run.status,
    };
  }

  /**
   * Get a run by ID
   */
  async getRunById(runId: bigint) {
    const run = await this.crawlRunRepo.findByIdWithContext(runId);
    if (!run) {
      throw new NotFoundException(`Run ${runId} not found`);
    }
    return run;
  }

  /**
   * Get all active contexts for scheduling
   */
  async getActiveContextsForScheduling() {
    return this.crawlRunRepo.getActiveContextsForScheduling();
  }

  /**
   * Check if a context has a running catalog run
   */
  async hasRunningCatalogRun(contextId: bigint): Promise<boolean> {
    return this.crawlRunRepo.hasRunningCatalogRun(contextId);
  }

  /**
   * Get recent runs for a context
   */
  async getRecentRunsForContext(contextId: bigint, limit = 10) {
    return this.crawlRunRepo.getRecentRunsForContext(contextId, limit);
  }
}
