import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CatalogRunService } from './catalog-run.service';
import { CatalogRunParams, serializeRunProgress } from '@app/common';

interface CreateCatalogRunDto {
  contextId: string;
  params?: CatalogRunParams;
}

@Controller('catalog-runs')
export class CatalogRunController {
  constructor(private readonly catalogRunService: CatalogRunService) {}

  /**
   * Create and start a new catalog run
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createAndStartRun(@Body() dto: CreateCatalogRunDto) {
    const contextId = BigInt(dto.contextId);

    // Check if there's already a running run
    const isRunning = await this.catalogRunService.hasRunningCatalogRun(contextId);
    if (isRunning) {
      return {
        success: false,
        error: 'A catalog run is already in progress for this context',
      };
    }

    // Create the run
    const run = await this.catalogRunService.createCatalogRun(contextId, {
      ...dto.params,
      scheduledBy: 'manual',
    });

    // Start the crawl
    await this.catalogRunService.startCatalogCrawl(run.runId);

    return {
      success: true,
      data: {
        runId: run.runId.toString(),
        contextId: run.contextId.toString(),
        status: run.status,
        startedAt: run.startedAt.toISOString(),
      },
    };
  }

  /**
   * Get a catalog run by ID
   */
  @Get(':runId')
  async getRunById(@Param('runId') runIdStr: string) {
    const runId = BigInt(runIdStr);
    const run = await this.catalogRunService.getRunById(runId);

    return {
      success: true,
      data: {
        runId: run.runId.toString(),
        contextId: run.contextId.toString(),
        runType: run.runType,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() || null,
        parameters: run.parameters,
        scraperVersion: run.scraperVersion,
        notes: run.notes,
        context: {
          contextId: run.context.contextId.toString(),
          label: run.context.label,
          pricingScope: run.context.pricingScope,
          merchant: {
            merchantId: run.context.merchant.merchantId.toString(),
            name: run.context.merchant.name,
          },
        },
      },
    };
  }

  /**
   * Get run progress statistics
   */
  @Get(':runId/progress')
  async getRunProgress(@Param('runId') runIdStr: string) {
    const runId = BigInt(runIdStr);
    const progress = await this.catalogRunService.getRunProgress(runId);

    return {
      success: true,
      data: serializeRunProgress(progress),
    };
  }

  /**
   * Get recent runs for a context
   */
  @Get('context/:contextId')
  async getRunsForContext(
    @Param('contextId') contextIdStr: string,
  ) {
    const contextId = BigInt(contextIdStr);
    const runs = await this.catalogRunService.getRecentRunsForContext(contextId);

    return {
      success: true,
      data: runs.map((run) => ({
        runId: run.runId.toString(),
        contextId: run.contextId.toString(),
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() || null,
      })),
    };
  }
}
