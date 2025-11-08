import { PartialType } from '@nestjs/swagger'
import { CreateDailyMarketIndexDto } from './create-daily-market-index.dto'

export class UpdateDailyMarketIndexDto extends PartialType(
  CreateDailyMarketIndexDto,
) {}
