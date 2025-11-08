import { PartialType } from '@nestjs/swagger';
import { CreateDailyPriceAggregateDto } from './create-daily-price-aggregate.dto';

export class UpdateDailyPriceAggregateDto extends PartialType(CreateDailyPriceAggregateDto) {}
