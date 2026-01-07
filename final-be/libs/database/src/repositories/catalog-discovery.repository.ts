import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CatalogDiscoveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a catalog discovery record
   */
  async upsertDiscovery(runId: bigint, contextId: bigint, productUrl: string, categoryId?: bigint) {
    return this.prisma.catalogDiscovery.upsert({
      where: {
        runId_productUrl: { runId, productUrl },
      },
      create: {
        runId,
        contextId,
        productUrl,
        categoryId,
        discoveredAt: new Date(),
      },
      update: {
        discoveredAt: new Date(),
        categoryId,
      },
    });
  }

  /**
   * Get all discoveries for a run
   */
  async getDiscoveriesForRun(runId: bigint) {
    return this.prisma.catalogDiscovery.findMany({
      where: { runId },
    });
  }

  /**
   * Count discoveries for a run
   */
  async countDiscoveriesForRun(runId: bigint): Promise<number> {
    return this.prisma.catalogDiscovery.count({
      where: { runId },
    });
  }

  /**
   * Get discovered product URLs for a run
   */
  async getDiscoveredUrlsForRun(runId: bigint): Promise<string[]> {
    const discoveries = await this.prisma.catalogDiscovery.findMany({
      where: { runId },
      select: { productUrl: true },
    });
    return discoveries.map((d) => d.productUrl);
  }
}
