import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface CreateHttpFetchData {
  runId: bigint;
  url: string;
  finalUrl?: string;
  httpStatus?: number;
  contentType?: string;
  durationMs?: number;
  responseHeaders?: Record<string, string>;
  bodyStorageKey?: string;
  bodySha256?: Buffer;
  bodyBytes?: bigint;
  errorClass?: string;
  errorMessage?: string;
  isBlocked?: boolean;
}

@Injectable()
export class HttpFetchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create an HTTP fetch record
   */
  async createFetch(data: CreateHttpFetchData) {
    return this.prisma.httpFetch.create({
      data: {
        ...data,
        fetchedAt: new Date(),
      },
    });
  }

  /**
   * Find fetch by ID
   */
  async findById(fetchId: bigint) {
    return this.prisma.httpFetch.findUnique({
      where: { fetchId },
    });
  }

  /**
   * Count fetches for a run
   */
  async countFetchesForRun(runId: bigint): Promise<number> {
    return this.prisma.httpFetch.count({
      where: { runId },
    });
  }

  /**
   * Count failed fetches for a run
   */
  async countFailedFetchesForRun(runId: bigint): Promise<number> {
    return this.prisma.httpFetch.count({
      where: {
        runId,
        OR: [{ errorClass: { not: null } }, { isBlocked: true }],
      },
    });
  }

  /**
   * Get recent fetches for a run
   */
  async getRecentFetchesForRun(runId: bigint, limit = 100) {
    return this.prisma.httpFetch.findMany({
      where: { runId },
      orderBy: { fetchedAt: 'desc' },
      take: limit,
    });
  }
}
