import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class MerchantProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert a product from catalog discovery
   */
  async upsertFromDiscovery(
    contextId: bigint,
    canonicalUrl: string,
    sourceProductId?: string,
    gtin?: string,
  ) {
    const now = new Date();
    return this.prisma.merchantProduct.upsert({
      where: {
        contextId_canonicalUrl: { contextId, canonicalUrl },
      },
      create: {
        contextId,
        canonicalUrl,
        sourceProductId,
        gtin,
        firstSeenAt: now,
        lastSeenAt: now,
        isActive: true,
      },
      update: {
        lastSeenAt: now,
        isActive: true,
        ...(sourceProductId && { sourceProductId }),
        ...(gtin && { gtin }),
      },
    });
  }

  /**
   * Find product by canonical URL
   */
  async findByCanonicalUrl(contextId: bigint, canonicalUrl: string) {
    return this.prisma.merchantProduct.findUnique({
      where: {
        contextId_canonicalUrl: { contextId, canonicalUrl },
      },
    });
  }

  /**
   * Update last seen timestamp for multiple products
   */
  async updateLastSeenForUrls(contextId: bigint, urls: string[], timestamp: Date) {
    return this.prisma.merchantProduct.updateMany({
      where: {
        contextId,
        canonicalUrl: { in: urls },
      },
      data: {
        lastSeenAt: timestamp,
        isActive: true,
      },
    });
  }

  /**
   * Find products not seen since a given date
   */
  async findStaleProducts(contextId: bigint, notSeenSince: Date) {
    return this.prisma.merchantProduct.findMany({
      where: {
        contextId,
        isActive: true,
        lastSeenAt: { lt: notSeenSince },
      },
    });
  }

  /**
   * Deactivate products not seen since a given date
   */
  async deactivateStaleProducts(contextId: bigint, notSeenSince: Date) {
    return this.prisma.merchantProduct.updateMany({
      where: {
        contextId,
        isActive: true,
        lastSeenAt: { lt: notSeenSince },
      },
      data: { isActive: false },
    });
  }

  /**
   * Count active products for a context
   */
  async countActiveProducts(contextId: bigint): Promise<number> {
    return this.prisma.merchantProduct.count({
      where: { contextId, isActive: true },
    });
  }
}
