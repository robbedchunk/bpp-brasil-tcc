import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScrapeLog } from '../../database/entities/scrape-log.entity';
import { ScrapeLogService } from './scrape-log.service';
import { ScrapeLogController } from './scrape-log.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ScrapeLog])],
  controllers: [ScrapeLogController],
  providers: [ScrapeLogService],
  exports: [ScrapeLogService],
})
export class ScrapeLogModule {}
