import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@app/common';
import { CatalogQueueProducer } from './catalog-queue.producer';

@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: QUEUE_NAMES.CATALOG_CRAWL,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      },
      {
        name: QUEUE_NAMES.CATEGORY_CRAWL,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      },
      {
        name: QUEUE_NAMES.PRODUCT_FETCH,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 3000,
          },
          removeOnComplete: { count: 5000 },
          removeOnFail: { count: 10000 },
        },
      },
      {
        name: QUEUE_NAMES.RECONCILIATION,
        defaultJobOptions: {
          attempts: 2,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        },
      },
    ),
  ],
  providers: [CatalogQueueProducer],
  exports: [CatalogQueueProducer, BullModule],
})
export class QueueModule {}
