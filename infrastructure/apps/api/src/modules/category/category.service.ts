import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from '../../database/entities/category.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Category)
    private readonly repo: Repository<Category>,
  ) {}

  findAll() {
    return this.repo.find({ relations: ['store'] });
  }

  async findOne(id: number) {
    const category = await this.repo.findOne({ where: { id }, relations: ['store'] });
    if (!category) throw new NotFoundException(`Category #${id} not found`);
    return category;
  }

  create(data: CreateCategoryDto) {
    const category = this.repo.create(data);
    return this.repo.save(category);
  }

  async update(id: number, data: UpdateCategoryDto) {
    const category = await this.findOne(id);
    Object.assign(category, data);
    return this.repo.save(category);
  }

  async remove(id: number) {
    const category = await this.findOne(id);
    await this.repo.remove(category);
    return { deleted: true };
  }
}
