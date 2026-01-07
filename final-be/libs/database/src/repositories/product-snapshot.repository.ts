import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ParsedProduct } from '@app/common';
import { Prisma } from '../../../../prisma/generated/client';

@Injectable()
export class ProductSnapshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a product snapshot from parsed product data
   */
  async createSnapshot(
    productId: bigint,
    runId: bigint,
    fetchId: bigint | null,
    product: ParsedProduct,
  ) {
    return this.prisma.productSnapshot.create({
      data: {
        productId,
        runId,
        fetchId,
        capturedAt: new Date(),
        name: product.name,
        brand: product.brand,
        description: product.description,
        categoryBreadcrumb: product.categoryBreadcrumb,
        packageSizeText: product.packageSizeText,
        imageUrls: product.imageUrls,
        attributes: product.attributes as Prisma.InputJsonValue,
        rawProductJson: product.rawProductJson as Prisma.InputJsonValue,
        parseOk: true,
        parseWarnings: [],
      },
    });
  }

  /**
   * Get latest snapshot for a product
   */
  async getLatestForProduct(productId: bigint) {
    return this.prisma.productSnapshot.findFirst({
      where: { productId },
      orderBy: { capturedAt: 'desc' },
    });
  }

  /**
   * Count snapshots for a run
   */
  async countSnapshotsForRun(runId: bigint): Promise<number> {
    return this.prisma.productSnapshot.count({
      where: { runId },
    });
  }
}
