import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ScrapeLog } from '../../database/entities/scrape-log.entity'
import { CreateScrapeLogDto } from './dto/create-scrape-log.dto'
import { UpdateScrapeLogDto } from './dto/update-scrape-log.dto'

@Injectable()
export class ScrapeLogService {
  constructor (
    @InjectRepository(ScrapeLog)
    private readonly repo: Repository<ScrapeLog>,
  ) {}

  findAll () {
    return this.repo.find({
      relations: ['scrape'],
      order: { createdAt: 'DESC' },
    })
  }

  async findOne (id: number) {
    const log = await this.repo.findOne({
      where: { id },
      relations: ['scrape'],
    })
    if (!log) throw new NotFoundException(`ScrapeLog #${id} not found`)
    return log
  }

  create (data: CreateScrapeLogDto) {
    const log = this.repo.create(data)
    return this.repo.save(log)
  }

  async update (id: number, data: UpdateScrapeLogDto) {
    const log = await this.findOne(id)
    Object.assign(log, data)
    return this.repo.save(log)
  }

  async remove (id: number) {
    const log = await this.findOne(id)
    await this.repo.remove(log)
    return { deleted: true }
  }
}
