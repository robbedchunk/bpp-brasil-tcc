import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { DailyPriceAggregate } from '../../database/entities/daily-price-aggregate.entity'
import { CreateDailyPriceAggregateDto } from './dto/create-daily-price-aggregate.dto'
import { UpdateDailyPriceAggregateDto } from './dto/update-daily-price-aggregate.dto'

@Injectable()
export class DailyPriceAggregateService {
  constructor (
    @InjectRepository(DailyPriceAggregate)
    private readonly repo: Repository<DailyPriceAggregate>,
  ) {}

  findAll () {
    return this.repo.find({ order: { day: 'DESC' }, take: 200 })
  }

  async findOne (id: number) {
    const record = await this.repo.findOne({ where: { id } })
    if (!record)
      throw new NotFoundException(`DailyPriceAggregate #${id} not found`)
    return record
  }

  create (data: CreateDailyPriceAggregateDto) {
    const entity = this.repo.create({
      day: data.day,
      regionId: data.regionId ?? null,
      categoryId: data.categoryId ?? null,
      avgPrice: data.avgPrice ?? null,
      minPrice: data.minPrice ?? null,
      maxPrice: data.maxPrice ?? null,
      itemCount: data.itemCount ?? null,
      meta: data.meta ?? null,
    })
    return this.repo.save(entity)
  }

  async update (id: number, data: UpdateDailyPriceAggregateDto) {
    const record = await this.findOne(id)
    Object.assign(record, data)
    return this.repo.save(record)
  }

  async remove (id: number) {
    const record = await this.findOne(id)
    await this.repo.remove(record)
    return { deleted: true }
  }
}
