import { PartialType } from '@nestjs/swagger';
import { CreateScrapeDto } from './create-scrape.dto';

export class UpdateScrapeDto extends PartialType(CreateScrapeDto) {}
