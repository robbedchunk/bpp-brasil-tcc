import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Proxy } from '../../database/entities/proxy.entity'

@Injectable()
export class ProxySelectionService {
  constructor (
    @InjectRepository(Proxy)
    private readonly proxyRepo: Repository<Proxy>,
  ) {}

  /**
   * Returns a random active proxy, preferring least recently used.
   */
  async getRandomActiveProxy (): Promise<Proxy | null> {
    const proxies = await this.proxyRepo
      .createQueryBuilder('proxy')
      .where('proxy.active = :active', { active: 1 })
      .orderBy('proxy.last_used', 'ASC', 'NULLS FIRST') // oldest first
      .limit(50)
      .getMany()

    if (proxies.length === 0) return null

    const proxy = proxies[Math.floor(Math.random() * proxies.length)]

    // Update lastUsed to mark reservation
    await this.proxyRepo.update(proxy.id, { last_used: new Date() })
    return proxy
  }

  /**
   * Get next proxy excluding a given one (e.g. if failed)
   */
  async getNextProxy (excludeId?: number): Promise<Proxy | null> {
    const qb = this.proxyRepo
      .createQueryBuilder('proxy')
      .where('proxy.active = :active', { active: 1 })
    if (excludeId) qb.andWhere('proxy.id != :excludeId', { excludeId })
    const proxies = await qb.orderBy('RANDOM()').limit(1).getMany()
    return proxies.length ? proxies[0] : null
  }
}
