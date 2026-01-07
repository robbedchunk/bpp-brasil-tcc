import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Product } from '../../database/entities/product.entity'
import { CreateProductDto } from './dto/create-product.dto'
import { UpdateProductDto } from './dto/update-product.dto'
 @Injectable()
export class ProductService {
  constructor (
    @InjectRepository(Product)
    private readonly repo: Repository<Product>,
  ) {}

  findAll () {
    return this.repo.find({
      relations: ['store', 'category', 'brand'],
      order: { id: 'DESC' },
    })
  }

  async findOne (id: number) {
    const product = await this.repo.findOne({
      where: { id },
      relations: ['store', 'category', 'brand'],
    })
    if (!product) throw new NotFoundException(`Product #${id} not found`)
    return product
  }

  create (data: CreateProductDto) {
    const product = this.repo.create(data)
    return this.repo.save(product)
  }

  async update (id: number, data: UpdateProductDto) {
    const product = await this.findOne(id)
    Object.assign(product, data)
    return this.repo.save(product)
  }

  async remove (id: number) {
    const product = await this.findOne(id)
    await this.repo.remove(product)
    return { deleted: true }
  }
}
