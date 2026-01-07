import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { DailyMarketIndex } from '../../database/entities/daily-market-index.entity'
import { DailyMarketIndexService } from './daily-market-index.service'
import { DailyMarketIndexController } from './daily-market-index.controller'

@Module({
  imports: [TypeOrmModule.forFeature([DailyMarketIndex])],
  controllers: [DailyMarketIndexController],
  providers: [DailyMarketIndexService],
  exports: [DailyMarketIndexService],
})
export class DailyMarketIndexModule {}
