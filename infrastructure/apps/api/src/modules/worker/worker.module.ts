import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Store } from '../../database/entities/store.entity'
import { ScrapeJob } from '../scrape/entities/scrape-job.entity'
import { ScrapeLog } from '../scrape/entities/scrape-log.entity'
import { WorkerService } from './worker.service'
import { SharedModule } from '../../shared/shared.module'
import { WorkerScheduler } from './worker.scheduler'
import { ScheduleModule } from '@nestjs/schedule'
import { ScrapeContent } from '../scrape/entities/scrape-content.entity'
import { Proxy } from '../../database/entities/proxy.entity'
import { ProxyUsage } from '../../database/entities/proxy-usage.entity'
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Store,
      ScrapeJob,
      ScrapeLog,
      ScrapeContent,
      Proxy,
      ProxyUsage,
    ]),
    SharedModule,
    ScheduleModule.forRoot(),
  ],
  providers: [WorkerService, WorkerScheduler],
  exports: [WorkerService],
})
export class WorkerModule {}
