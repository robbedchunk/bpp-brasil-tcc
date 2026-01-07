import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '@app/database';
import { QUEUE_NAMES } from '@app/common';
import { CategoryCrawlProcessor } from './processors/category-crawl.processor';
import { ProductFetchProcessor } from './processors/product-fetch.processor';
import { CrawlerRegistry } from './crawlers/registry/crawler.registry';
import { HttpFetchService } from './services/http-fetch.service';
import {
  CrawlRunRepository,
  CatalogDiscoveryRepository,
  MerchantCategoryRepository,
  MerchantProductRepository,
  HttpFetchRepository,
  ProductSnapshotRepository,
} from '@app/database';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.CATEGORY_CRAWL },
      { name: QUEUE_NAMES.PRODUCT_FETCH },
      { name: QUEUE_NAMES.RECONCILIATION },
    ),
    PrismaModule,
  ],
  providers: [
    // Processors
    CategoryCrawlProcessor,
    ProductFetchProcessor,
    // Services
    CrawlerRegistry,
    HttpFetchService,
    // Repositories
    CrawlRunRepository,
    CatalogDiscoveryRepository,
    MerchantCategoryRepository,
    MerchantProductRepository,
    HttpFetchRepository,
    ProductSnapshotRepository,
  ],
})
export class CrawlerWorkerModule {}
