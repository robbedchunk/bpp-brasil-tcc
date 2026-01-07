import { PartialType } from '@nestjs/swagger';
import { CreateFxRateDto } from './create-fx-rate.dto';

export class UpdateFxRateDto extends PartialType(CreateFxRateDto) {}
