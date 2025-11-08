import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ScrapeService } from './scrape.service'
import { ScrapeController } from './scrape.controller'
import { ScrapeJob } from './entities/scrape-job.entity'
import { ScrapeLog } from './entities/scrape-log.entity'
import { ScrapeScheduler } from '../scrape/scrape.scheduler'
import { SharedModule } from '../../shared/shared.module'
import { Scrape } from '../../database/entities/scrape.entity'

@Module({
  imports: [
    TypeOrmModule.forFeature([ScrapeJob, ScrapeLog, Scrape]),
    SharedModule,
  ],
  controllers: [ScrapeController],
  providers: [ScrapeService, ScrapeScheduler],
  exports: [ScrapeService],
})
export class ScrapeModule {}
