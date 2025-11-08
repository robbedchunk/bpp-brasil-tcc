import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ExtractionModel } from '../../database/entities/extraction-model.entity'
import { CreateExtractionModelDto } from './dto/create-extraction-model.dto'
import { UpdateExtractionModelDto } from './dto/update-extraction-model.dto'

@Injectable()
export class ExtractionModelService {
  constructor (
    @InjectRepository(ExtractionModel)
    private readonly repo: Repository<ExtractionModel>,
  ) {}

  findAll () {
    return this.repo.find({ order: { id: 'DESC' } })
  }

  async findOne (id: number) {
    const model = await this.repo.findOne({ where: { id } })
    if (!model) throw new NotFoundException(`ExtractionModel #${id} not found`)
    return model
  }

  create (data: CreateExtractionModelDto) {
    const model = this.repo.create({
      ...data,
      // include only if column exists
      active: data.active ?? true,
    } as Partial<ExtractionModel>)
    return this.repo.save(model)
  }

  async update (id: number, data: UpdateExtractionModelDto) {
    const model = await this.findOne(id)
    Object.assign(model, data)
    return this.repo.save(model)
  }

  async remove (id: number) {
    const model = await this.findOne(id)
    await this.repo.remove(model)
    return { deleted: true }
  }
}
