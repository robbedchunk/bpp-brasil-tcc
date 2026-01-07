import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CatalogRunService } from '../catalog-run/catalog-run.service';

@Injectable()
export class CatalogSchedulerService {
  private readonly logger = new Logger(CatalogSchedulerService.name);

  constructor(private readonly catalogRunService: CatalogRunService) {}

  /**
   * Weekly catalog crawl - runs every Sunday at 2:00 AM (São Paulo timezone)
   * Cron expression: second minute hour day-of-month month day-of-week
   */
  @Cron('0 0 2 * * 0', {
    name: 'weekly-catalog-crawl',
    timeZone: 'America/Sao_Paulo',
  })
  async triggerWeeklyCatalogCrawl(): Promise<void> {
    this.logger.log('Starting weekly catalog crawl for all contexts');

    const contexts = await this.catalogRunService.getActiveContextsForScheduling();
    this.logger.log(`Found ${contexts.length} active contexts to crawl`);

    let started = 0;
    let skipped = 0;
    let failed = 0;

    for (const context of contexts) {
      try {
        // Skip if already running
        const isRunning = await this.catalogRunService.hasRunningCatalogRun(
          context.contextId,
        );

        if (isRunning) {
          this.logger.warn(
            `Context ${context.contextId} (${context.label}) already has a running catalog run, skipping`,
          );
          skipped++;
          continue;
        }

        // Create and start the run
        const run = await this.catalogRunService.createCatalogRun(
          context.contextId,
          {
            scheduledBy: 'weekly-cron',
            weekNumber: this.getISOWeekNumber(),
          },
        );

        await this.catalogRunService.startCatalogCrawl(run.runId);

        this.logger.log(
          `Started catalog run ${run.runId} for ${context.merchant.name} - ${context.label}`,
        );

        started++;

        // Small delay between context starts to avoid overwhelming the system
        await this.sleep(1000);
      } catch (error) {
        this.logger.error(
          `Failed to start catalog run for context ${context.contextId}: ${error.message}`,
          error.stack,
        );
        failed++;
      }
    }

    this.logger.log(
      `Weekly catalog crawl scheduling complete: ${started} started, ${skipped} skipped, ${failed} failed`,
    );
  }

  /**
   * Manual trigger for a specific context
   */
  async triggerManualCatalogCrawl(contextId: bigint) {
    const isRunning = await this.catalogRunService.hasRunningCatalogRun(contextId);

    if (isRunning) {
      throw new ConflictException(
        `Context ${contextId} already has a running catalog run`,
      );
    }

    const run = await this.catalogRunService.createCatalogRun(contextId, {
      scheduledBy: 'manual',
    });

    await this.catalogRunService.startCatalogCrawl(run.runId);

    return run;
  }

  /**
   * Get ISO week number of the current date
   */
  private getISOWeekNumber(): number {
    const date = new Date();
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
