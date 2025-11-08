import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Proxy } from '../../database/entities/proxy.entity'
import { CreateProxyDto } from './dto/create-proxy.dto'
import { UpdateProxyDto } from './dto/update-proxy.dto'

@Injectable()
export class ProxyService {
  constructor (
    @InjectRepository(Proxy)
    private readonly repo: Repository<Proxy>,
  ) {}

  findAll () {
    return this.repo.find({ order: { id: 'DESC' } })
  }

  async findOne (id: number) {
    const proxy = await this.repo.findOne({ where: { id } })
    if (!proxy) throw new NotFoundException(`Proxy #${id} not found`)
    return proxy
  }

  create (data: CreateProxyDto) {
    const proxy = this.repo.create(data)
    return this.repo.save(proxy)
  }

  async update (id: number, data: UpdateProxyDto) {
    const proxy = await this.findOne(id)
    Object.assign(proxy, data)
    return this.repo.save(proxy)
  }

  async markUsed (id: number) {
    const proxy = await this.findOne(id)
    proxy.last_used = new Date()
    return this.repo.save(proxy)
  }

  async remove (id: number) {
    const proxy = await this.findOne(id)
    await this.repo.remove(proxy)
    return { deleted: true }
  }
}
