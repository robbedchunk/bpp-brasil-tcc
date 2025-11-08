import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProductLink } from '../../database/entities/product-link.entity';
import { CreateProductLinkDto } from './dto/create-product-link.dto';
import { UpdateProductLinkDto } from './dto/update-product-link.dto';

@Injectable()
export class ProductLinkService {
  constructor(
    @InjectRepository(ProductLink)
    private readonly repo: Repository<ProductLink>,
  ) {}

  findAll() {
    return this.repo.find({
      relations: ['product', 'linkedProduct'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number) {
    const link = await this.repo.findOne({
      where: { id },
      relations: ['product', 'linkedProduct'],
    });
    if (!link) throw new NotFoundException(`ProductLink #${id} not found`);
    return link;
  }

  create(data: CreateProductLinkDto) {
    const entity = this.repo.create({
      product: { id: data.productId } as any,
      linkedProduct: { id: data.linkedProductId } as any,
      type: data.type ?? 'equivalent',
      source: data.source ?? 'manual',
    });
    return this.repo.save(entity);
  }

  async update(id: number, data: UpdateProductLinkDto) {
    const link = await this.findOne(id);
    Object.assign(link, {
      ...data,
      product: data.productId ? ({ id: data.productId } as any) : link.product,
      linkedProduct: data.linkedProductId ? ({ id: data.linkedProductId } as any) : link.linkedProduct,
    });
    return this.repo.save(link);
  }

  async remove(id: number) {
    const link = await this.findOne(id);
    await this.repo.remove(link);
    return { deleted: true };
  }
}
