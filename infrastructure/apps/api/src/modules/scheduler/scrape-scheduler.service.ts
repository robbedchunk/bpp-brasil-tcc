import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Scrape } from '../../database/entities/scrape.entity'
import { ScrapeRun } from '../../database/entities/scrape-run.entity'

@Injectable()
export class ScrapeSchedulerService {
  private readonly logger = new Logger(ScrapeSchedulerService.name)

  constructor (
    @InjectRepository(Scrape)
    private readonly scrapeRepo: Repository<Scrape>,
    @InjectRepository(ScrapeRun)
    private readonly scrapeRunRepo: Repository<ScrapeRun>,
  ) {}

  /**
   * Cron job that runs every 5 minutes.
   * Looks for queued scrapes and starts new runs if needed.
   */
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'monitor-scrape-queue',
    waitForCompletion: true,
  })
  async monitorScrapeQueue () {
    this.logger.log('Checking scrape queue...')

    const queued = await this.scrapeRepo.find({
      where: { status: 'queued' },
      relations: ['store', 'region'],
      take: 20,
    })

    if (queued.length === 0) {
      this.logger.log('No queued scrapes found.')
      return
    }

    this.logger.log(`Found ${queued.length} queued scrapes. Starting runs...`)

    for (const scrape of queued) {
      try {
        // Create scrape_run record
        const run = this.scrapeRunRepo.create({
          startedAt: new Date(),
          status: 'running',
          initiatedBy: 'scheduler',
          stats: { scrapeId: scrape.id, store: scrape.store?.name },
        })
        const savedRun = await this.scrapeRunRepo.save(run)

        // Update scrape to "running"
        scrape.status = 'running'
        scrape.scrapeRun = savedRun
        scrape.startedAt = new Date()
        await this.scrapeRepo.save(scrape)

        this.logger.log(
          `Started scrape #${scrape.id} (store: ${
            scrape.store?.name || 'unknown'
          })`,
        )

        // 👉 here you'd dispatch an async task to a scraper worker or queue
        // e.g., send a message to BullMQ / RabbitMQ / external worker
      } catch (err) {
        this.logger.error(
          `Failed to start scrape #${scrape.id}: ${err.message}`,
        )
      }
    }

    this.logger.log('Scrape scheduler cycle complete.')
  }
}
