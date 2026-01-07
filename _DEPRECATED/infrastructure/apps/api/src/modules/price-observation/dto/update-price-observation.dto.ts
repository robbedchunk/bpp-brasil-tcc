import { PartialType } from '@nestjs/swagger'
import { CreatePriceObservationDto } from './create-price-observation.dto'

export class UpdatePriceObservationDto extends PartialType(
  CreatePriceObservationDto,
) {}
