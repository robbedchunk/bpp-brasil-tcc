import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { FxRate } from '../../database/entities/fx-rate.entity'
import { CreateFxRateDto } from './dto/create-fx-rate.dto'
import { UpdateFxRateDto } from './dto/update-fx-rate.dto'

@Injectable()
export class FxRateService {
  constructor (
    @InjectRepository(FxRate)
    private readonly repo: Repository<FxRate>,
  ) {}

  findAll () {
    return this.repo.find({ order: { day: 'DESC' } })
  }

  async findOne (id: number) {
    const record = await this.repo.findOne({ where: { id } })
    if (!record) throw new NotFoundException(`FX rate #${id} not found`)
    return record
  }

  create (data: CreateFxRateDto) {
    const entity = this.repo.create({
      day: data.day,
      baseCurrency: data.baseCurrency,
      quoteCurrency: data.quoteCurrency,
      rate: data.rate,
      source: data.source ?? null,
      meta: data.meta ?? null,
    })
    return this.repo.save(entity)
  }

  async update (id: number, data: UpdateFxRateDto) {
    const record = await this.findOne(id)
    Object.assign(record, {
      baseCurrency: data.baseCurrency ?? record.baseCurrency,
      quoteCurrency: data.quoteCurrency ?? record.quoteCurrency,
      rate: data.rate ?? record.rate,
      source: data.source ?? record.source,
      meta: data.meta ?? record.meta,
    })
    return this.repo.save(record)
  }

  async remove (id: number) {
    const record = await this.findOne(id)
    await this.repo.remove(record)
    return { deleted: true }
  }
}
