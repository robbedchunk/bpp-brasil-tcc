import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { Redis } from 'ioredis'

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis

  constructor () {
    this.client = new Redis(process.env.REDIS_URL || 'redis://redis:6379')
  }

  async publish (channel: string, data: any) {
    return this.client.publish(channel, JSON.stringify(data))
  }

  onModuleDestroy () {
    this.client.quit()
  }
}
