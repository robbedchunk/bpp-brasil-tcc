import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Scrape } from '../../database/entities/scrape.entity'
import { ScrapeRun } from '../../database/entities/scrape-run.entity'
import { ScrapeSchedulerService } from './scrape-scheduler.service'
import { ScrapeService } from '../scrape/scrape.service'
import { ScrapeRunService } from '../scrape-run/scrape-run.service'

@Module({
  imports: [TypeOrmModule.forFeature([Scrape, ScrapeRun])],
  providers: [ScrapeSchedulerService, ScrapeService, ScrapeRunService],
})
export class ScrapeScheduler {}
