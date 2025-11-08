import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Region } from '../../database/entities/region.entity';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';

@Injectable()
export class RegionService {
  constructor(
    @InjectRepository(Region)
    private readonly repo: Repository<Region>,
  ) {}

  findAll() {
    return this.repo.find();
  }

  async findOne(id: number) {
    const region = await this.repo.findOne({ where: { id } });
    if (!region) throw new NotFoundException(`Region #${id} not found`);
    return region;
  }

  create(data: CreateRegionDto) {
    const region = this.repo.create(data);
    return this.repo.save(region);
  }

  async update(id: number, data: UpdateRegionDto) {
    const region = await this.findOne(id);
    Object.assign(region, data);
    return this.repo.save(region);
  }

  async remove(id: number) {
    const region = await this.findOne(id);
    await this.repo.remove(region);
    return { deleted: true };
  }
}
