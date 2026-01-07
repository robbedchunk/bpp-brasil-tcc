import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class MerchantCategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a merchant category
   */
  async upsertCategory(
    contextId: bigint,
    runId: bigint,
    categoryUrl: string,
    name: string,
    breadcrumb: string[],
    parentCategoryId?: bigint,
  ) {
    return this.prisma.merchantCategory.upsert({
      where: {
        contextId_categoryUrl: { contextId, categoryUrl },
      },
      create: {
        contextId,
        categoryUrl,
        name,
        breadcrumb,
        parentCategoryId,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastSeenRunId: runId,
      },
      update: {
        name,
        breadcrumb,
        parentCategoryId,
        lastSeenAt: new Date(),
        lastSeenRunId: runId,
      },
    });
  }

  /**
   * Find category by URL
   */
  async findByUrl(contextId: bigint, categoryUrl: string) {
    return this.prisma.merchantCategory.findUnique({
      where: {
        contextId_categoryUrl: { contextId, categoryUrl },
      },
    });
  }

  /**
   * Get all categories for a context
   */
  async getCategoriesForContext(contextId: bigint) {
    return this.prisma.merchantCategory.findMany({
      where: { contextId },
      orderBy: { breadcrumb: 'asc' },
    });
  }

  /**
   * Count categories seen in a run
   */
  async countCategoriesForRun(runId: bigint): Promise<number> {
    return this.prisma.merchantCategory.count({
      where: { lastSeenRunId: runId },
    });
  }
}
