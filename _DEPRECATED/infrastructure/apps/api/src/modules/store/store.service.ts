import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Store } from '../../database/entities/store.entity';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class StoreService {
  constructor(
    @InjectRepository(Store)
    private readonly repo: Repository<Store>,
  ) {}

  findAll() {
    return this.repo.find();
  }

  async findOne(id: number) {
    const store = await this.repo.findOne({ where: { id } });
    if (!store) throw new NotFoundException(`Store #${id} not found`);
    return store;
  }

  create(data: CreateStoreDto) {
    const store = this.repo.create(data);
    return this.repo.save(store);
  }

  async update(id: number, data: UpdateStoreDto) {
    const store = await this.findOne(id);
    Object.assign(store, data);
    return this.repo.save(store);
  }

  async remove(id: number) {
    const store = await this.findOne(id);
    await this.repo.remove(store);
    return { deleted: true };
  }
}
