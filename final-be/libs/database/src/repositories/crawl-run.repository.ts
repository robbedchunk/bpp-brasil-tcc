import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CatalogRunParams } from '@app/common';
import { Prisma } from '../../../../prisma/generated/client';

export type CrawlRunStatus = 'running' | 'succeeded' | 'failed' | 'partial';
export type CrawlRunType = 'catalog' | 'price';

@Injectable()
export class CrawlRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new catalog run for a merchant context
   */
  async createCatalogRun(contextId: bigint, params?: CatalogRunParams) {
    return this.prisma.crawlRun.create({
      data: {
        contextId,
        runType: 'catalog',
        startedAt: new Date(),
        status: 'running',
        parameters: (params ?? {}) as Prisma.InputJsonValue,
        scraperVersion: process.env.SCRAPER_VERSION || '1.0.0',
      },
    });
  }

  /**
   * Find a crawl run by ID
   */
  async findById(runId: bigint) {
    return this.prisma.crawlRun.findUnique({
      where: { runId },
    });
  }

  /**
   * Find a crawl run by ID with context and merchant included
   */
  async findByIdWithContext(runId: bigint) {
    return this.prisma.crawlRun.findUnique({
      where: { runId },
      include: {
        context: {
          include: {
            merchant: true,
          },
        },
      },
    });
  }

  /**
   * Update run status
   */
  async updateStatus(runId: bigint, status: CrawlRunStatus, notes?: string) {
    const data: Prisma.CrawlRunUpdateInput = { status };

    if (status !== 'running') {
      data.finishedAt = new Date();
    }
    if (notes) {
      data.notes = notes;
    }

    return this.prisma.crawlRun.update({
      where: { runId },
      data,
    });
  }

  /**
   * Check if a context has a running catalog run
   */
  async hasRunningCatalogRun(contextId: bigint): Promise<boolean> {
    const running = await this.prisma.crawlRun.findFirst({
      where: {
        contextId,
        runType: 'catalog',
        status: 'running',
      },
    });
    return !!running;
  }

  /**
   * Get recent catalog runs for a context
   */
  async getRecentRunsForContext(contextId: bigint, limit = 10) {
    return this.prisma.crawlRun.findMany({
      where: {
        contextId,
        runType: 'catalog',
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get all active merchant contexts for scheduling
   */
  async getActiveContextsForScheduling() {
    return this.prisma.merchantContext.findMany({
      include: {
        merchant: true,
      },
    });
  }

  /**
   * Get the Nth previous successful catalog run for a context
   */
  async getNthPreviousSuccessfulRun(contextId: bigint, n: number) {
    return this.prisma.crawlRun.findFirst({
      where: {
        contextId,
        runType: 'catalog',
        status: 'succeeded',
      },
      orderBy: { startedAt: 'desc' },
      skip: n,
    });
  }
}
