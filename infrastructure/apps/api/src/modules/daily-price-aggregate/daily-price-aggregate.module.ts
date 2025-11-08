import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { DailyPriceAggregate } from '../../database/entities/daily-price-aggregate.entity'
import { DailyPriceAggregateService } from './daily-price-aggregate.service'
import { DailyPriceAggregateController } from './daily-price-aggregate.controller'

@Module({
  imports: [TypeOrmModule.forFeature([DailyPriceAggregate])],
  controllers: [DailyPriceAggregateController],
  providers: [DailyPriceAggregateService],
  exports: [DailyPriceAggregateService],
})
export class DailyPriceAggregateModule {}
