import { Injectable, NotFoundException, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Scrape } from '../../database/entities/scrape.entity'
import { CreateScrapeDto } from './dto/create-scrape.dto'
import { UpdateScrapeDto } from './dto/update-scrape.dto'
import { RedisService } from '../../shared/redis.service'

@Injectable()
export class ScrapeService {
  private readonly logger = new Logger(ScrapeService.name)

  constructor (
    @InjectRepository(Scrape)
    private readonly repo: Repository<Scrape>,
    private readonly redis: RedisService,
  ) {}

  findAll () {
    return this.repo.find({
      relations: ['scrapeRun', 'store', 'region'],
      order: { id: 'DESC' },
    })
  }

  async findOne (id: number) {
    const job = await this.repo.findOne({
      where: { id },
      relations: ['scrapeRun', 'store', 'region'],
    })
    if (!job) throw new NotFoundException(`Scrape #${id} not found`)
    return job
  }

  create (data: CreateScrapeDto) {
    const job = this.repo.create({
      ...data,
      startedAt: new Date(),
      status: data.status ?? 'queued',
    })
    return this.repo.save(job)
  }

  async update (id: number, data: UpdateScrapeDto) {
    const job = await this.findOne(id)
    Object.assign(job, data)
    return this.repo.save(job)
  }

  async finish (id: number, success: boolean, error?: string | null) {
    const job = await this.findOne(id)
    job.finishedAt = new Date()
    job.status = success ? 'success' : 'error'
    job.errorMessage = error ?? null
    return this.repo.save(job)
  }

  async remove (id: number) {
    const job = await this.findOne(id)
    await this.repo.remove(job)
    return { deleted: true }
  }

  async queueJob (jobId: number) {
    const job = await this.findOne(jobId)
    await this.redis.publish('tasks', {
      jobId: job.id,
      url: job.sourceUrl,
      storeId: job.store?.id,
    })
    this.logger.log(`Queued scrape job #${job.id} for URL ${job.sourceUrl}`)
    job.status = 'queued'
    await this.repo.save(job)
    return { queued: true, job }
  }

  async handleWorkerReport (report: {
    jobId: number
    success: boolean
    errorMessage?: string
    discoveredLinks?: string[]
  }) {
    const job = await this.findOne(report.jobId)
    if (!job)
      throw new NotFoundException(`Scrape job ${report.jobId} not found`)

    await this.finish(job.id, report.success, report.errorMessage)

    this.logger.log(
      `Worker reported: Job #${job.id} ${report.success ? 'success' : 'error'}`,
    )

    // Optionally handle discovered links
    if (report.discoveredLinks?.length) {
      this.logger.log(
        `Job #${job.id}: Discovered ${report.discoveredLinks.length} inner links`,
      )
      // TODO: save new jobs for each discovered link
    }

    return { ok: true }
  }
}
