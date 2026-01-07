import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { PriceObservation } from '../../database/entities/price-observation.entity'
import { CreatePriceObservationDto } from './dto/create-price-observation.dto'
import { UpdatePriceObservationDto } from './dto/update-price-observation.dto'

@Injectable()
export class PriceObservationService {
  constructor (
    @InjectRepository(PriceObservation)
    private readonly repo: Repository<PriceObservation>,
  ) {}

  findAll () {
    return this.repo.find({
      relations: ['product', 'region', 'scrape'],
      order: { id: 'DESC' },
      take: 200,
    })
  }

  async findOne (id: number) {
    const row = await this.repo.findOne({
      where: { id },
      relations: ['product', 'region', 'scrape'],
    })
    if (!row) throw new NotFoundException(`PriceObservation #${id} not found`)
    return row
  }

  create (data: CreatePriceObservationDto) {
    // Build relation objects instead of foreign key ids
    const entity = this.repo.create({
      product: { id: data.productId } as any,
      region: data.regionId ? ({ id: data.regionId } as any) : undefined,
      scrape: data.scrapeId ? ({ id: data.scrapeId } as any) : undefined,
      price: data.price,
      currency: data.currency,
      availability: data.availability ? true : false,
      observedAt: data.observedAt ? new Date(data.observedAt) : new Date(),
      sourceUrl: data.sourceUrl ?? undefined,
      // remove this line if configVersion column doesn’t exist
      // configVersion: data.configVersion ?? undefined,
    })
    return this.repo.save(entity)
  }

  async update (id: number, data: UpdatePriceObservationDto) {
    const current = await this.findOne(id)
    Object.assign(current, {
      ...data,
      product: data.productId
        ? ({ id: data.productId } as any)
        : current.product,
      region: data.regionId ? ({ id: data.regionId } as any) : current.region,
      scrape: data.scrapeId ? ({ id: data.scrapeId } as any) : current.scrape,
      observedAt: data.observedAt
        ? new Date(data.observedAt)
        : current.observedAt,
      sourceUrl: data.sourceUrl ?? current.sourceUrl ?? undefined,
      // remove or comment next line if no column
      // configVersion: data.configVersion ?? current.configVersion ?? undefined,
    })
    return this.repo.save(current)
  }

  async remove (id: number) {
    const row = await this.findOne(id)
    await this.repo.remove(row)
    return { deleted: true }
  }
}
