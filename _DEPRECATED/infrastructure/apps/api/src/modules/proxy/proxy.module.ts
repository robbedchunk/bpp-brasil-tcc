import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Proxy } from '../../database/entities/proxy.entity'
import { ProxyService } from './proxy.service'
import { ProxyController } from './proxy.controller'
import { ProxySelectionService } from './proxy-selection.service'

@Module({
  imports: [TypeOrmModule.forFeature([Proxy])],
  controllers: [ProxyController],
  providers: [ProxyService, ProxySelectionService],
  exports: [ProxyService, ProxySelectionService],
})
export class ProxyModule {}
