import { Module } from '@nestjs/common';
import { CatalogRunService } from './catalog-run.service';
import { CatalogRunController } from './catalog-run.controller';
import { QueueModule } from '../queue/queue.module';
import {
  CrawlRunRepository,
  CatalogDiscoveryRepository,
  MerchantCategoryRepository,
  HttpFetchRepository,
} from '@app/database';

@Module({
  imports: [QueueModule],
  controllers: [CatalogRunController],
  providers: [
    CatalogRunService,
    CrawlRunRepository,
    CatalogDiscoveryRepository,
    MerchantCategoryRepository,
    HttpFetchRepository,
  ],
  exports: [CatalogRunService],
})
export class CatalogRunModule {}
