import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ProductLink } from '../../database/entities/product-link.entity'
import { ProductLinkService } from './product-link.service'
import { ProductLinkController } from './product-link.controller'

@Module({
  imports: [TypeOrmModule.forFeature([ProductLink])],
  controllers: [ProductLinkController],
  providers: [ProductLinkService],
  exports: [ProductLinkService],
})
export class ProductLinkModule {}
