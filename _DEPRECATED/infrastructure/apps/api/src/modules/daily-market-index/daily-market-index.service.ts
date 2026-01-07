import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { DailyMarketIndex } from '../../database/entities/daily-market-index.entity'
import { CreateDailyMarketIndexDto } from './dto/create-daily-market-index.dto'
import { UpdateDailyMarketIndexDto } from './dto/update-daily-market-index.dto'

@Injectable()
export class DailyMarketIndexService {
  constructor (
    @InjectRepository(DailyMarketIndex)
    private readonly repo: Repository<DailyMarketIndex>,
  ) {}

  findAll () {
    return this.repo.find({ order: { day: 'DESC' } })
  }

  async findOne (day: string, countryCode?: string | null) {
    const where = countryCode ? { day, countryCode } : { day }
    const record = await this.repo.findOne({ where })
    if (!record)
      throw new NotFoundException(
        `No market index for ${day}${countryCode ? ' in ' + countryCode : ''}`,
      )
    return record
  }

  create (data: CreateDailyMarketIndexDto) {
    const entity = this.repo.create({
      day: data.day,
      countryCode: data.countryCode ?? null,
      zipCode: data.zipCode ?? null,
      indexLevel: data.indexLevel ?? null,
      method: data.method ?? null,
      meta: data.meta ?? null,
    })
    return this.repo.save(entity)
  }

  async update (day: string, data: UpdateDailyMarketIndexDto) {
    const record = await this.findOne(day, data.countryCode)
    Object.assign(record, {
      zipCode: data.zipCode ?? record.zipCode,
      indexLevel: data.indexLevel ?? record.indexLevel,
      method: data.method ?? record.method,
      meta: data.meta ?? record.meta,
    })
    return this.repo.save(record)
  }

  async remove (day: string, countryCode?: string | null) {
    const record = await this.findOne(day, countryCode)
    await this.repo.remove(record)
    return { deleted: true }
  }
}
