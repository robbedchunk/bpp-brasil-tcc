import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { WorkerService } from './worker.service'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ScrapeJob } from '../scrape/entities/scrape-job.entity'
import { Proxy } from '../../database/entities/proxy.entity'
import { ProxyUsage } from '../../database/entities/proxy-usage.entity'

// TODO: This is a hacky way to get the worker service injected into the scheduler

@Injectable()
export class WorkerScheduler {
  private readonly logger = new Logger(WorkerScheduler.name)

  constructor (
    private readonly workerService: WorkerService,
    @InjectRepository(ScrapeJob)
    private readonly jobRepo: Repository<ScrapeJob>,
    @InjectRepository(Proxy)
    private readonly proxyRepo: Repository<Proxy>,
    @InjectRepository(ProxyUsage)
    private readonly proxyUsageRepo: Repository<ProxyUsage>,
  ) {}

  @Cron('0 * * * *') // every hour
  async checkProxyHealth () {
    const badProxies = await this.proxyRepo
      .createQueryBuilder('proxy')
      .where('failureCount > successCount')
      .andWhere('totalRequests > 10')
      .getMany()

    for (const proxy of badProxies) {
      this.logger.warn(`Disabling bad proxy ${proxy.ip}:${proxy.port}`)
      await this.proxyRepo.update(proxy.id, { active: false })
    }
  }

  @Cron('0 3 * * *') // every day at 3 AM
  async resetOldJobs () {
    const threshold = new Date(Date.now() - 24 * 3600 * 1000)
    await this.jobRepo
      .createQueryBuilder()
      .update(ScrapeJob)
      .set({ status: 'pending' })
      .where('last_scraped IS NULL OR last_scraped < :threshold', { threshold })
      .andWhere('status != :in_progress', { in_progress: 'in_progress' })
      .execute()
    this.logger.log('Reset old scrape jobs to pending.')
  }

  // Run every 10 minutes by default
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'scrape_concurrent_continuous',
    waitForCompletion: true,
  })
  async handleCron () {
    this.logger.log('Cron: Starting scheduled scraping run...')
    try {
      await this.workerService.runAllStores()
      this.logger.log('Cron: Scraping run finished successfully.')
    } catch (error) {
      this.logger.error('Cron: Error during scraping run', error)
    }
  }
}
