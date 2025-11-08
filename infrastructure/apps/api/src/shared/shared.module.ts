import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RedisService } from './redis.service'
import { UserAgentService } from './user-agent.service'
import { UrlUtilsService } from './url-utils.service'
import { Proxy } from '../database/entities/proxy.entity'
import { ProxySelectionService } from '../modules/proxy/proxy-selection.service'

@Module({
  imports: [TypeOrmModule.forFeature([Proxy])],

  providers: [
    RedisService,
    UserAgentService,
    UrlUtilsService,
    ProxySelectionService,
  ],
  exports: [
    RedisService,
    UserAgentService,
    UrlUtilsService,
    ProxySelectionService,
  ],
})
export class SharedModule {}
