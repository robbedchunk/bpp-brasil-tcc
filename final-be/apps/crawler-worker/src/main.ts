import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { CrawlerWorkerModule } from './crawler-worker.module';

async function bootstrap() {
  const logger = new Logger('CrawlerWorker');

  // Create application without HTTP server (pure queue worker)
  const app = await NestFactory.createApplicationContext(CrawlerWorkerModule);

  logger.log('Crawler worker started and listening for jobs');

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.log('Shutting down crawler worker...');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap();
