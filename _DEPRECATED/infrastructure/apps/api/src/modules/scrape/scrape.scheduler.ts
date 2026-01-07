import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { ScrapeService } from './scrape.service'

@Injectable()
export class ScrapeScheduler {
  private readonly logger = new Logger(ScrapeScheduler.name)

  constructor (private readonly scrapeService: ScrapeService) {}

  /**
   *  Run every 10 minutes
   * - Find pending scrape jobs
   * - Queue them to Redis for the worker
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron () {
    const jobs = await this.scrapeService.findAll()
    const pending = jobs.filter(j => j.status === 'pending')
    for (const job of pending) {
      await this.scrapeService.queueJob(job.id)
    }
    this.logger.log(`Queued ${pending.length} pending scrape jobs`)
  }
}
