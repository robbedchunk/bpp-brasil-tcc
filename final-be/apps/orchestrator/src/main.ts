import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { OrchestratorModule } from './orchestrator.module';

async function bootstrap() {
  const logger = new Logger('Orchestrator');
  const app = await NestFactory.create(OrchestratorModule);

  const port = process.env.ORCHESTRATOR_PORT || 3000;
  await app.listen(port);

  logger.log(`Orchestrator is running on port ${port}`);
}

bootstrap();
