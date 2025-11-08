import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Brand } from '../../database/entities/brand.entity';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@Injectable()
export class BrandService {
  constructor(
    @InjectRepository(Brand)
    private readonly repo: Repository<Brand>,
  ) {}

  findAll() {
    return this.repo.find();
  }

  async findOne(id: number) {
    const brand = await this.repo.findOne({ where: { id } });
    if (!brand) throw new NotFoundException(`Brand #${id} not found`);
    return brand;
  }

  create(data: CreateBrandDto) {
    const brand = this.repo.create(data);
    return this.repo.save(brand);
  }

  async update(id: number, data: UpdateBrandDto) {
    const brand = await this.findOne(id);
    Object.assign(brand, data);
    return this.repo.save(brand);
  }

  async remove(id: number) {
    const brand = await this.findOne(id);
    await this.repo.remove(brand);
    return { deleted: true };
  }
}
