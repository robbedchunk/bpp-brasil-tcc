import { PartialType } from '@nestjs/swagger';
import { CreateExtractionModelDto } from './create-extraction-model.dto';

export class UpdateExtractionModelDto extends PartialType(CreateExtractionModelDto) {}
