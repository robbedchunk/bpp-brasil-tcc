import { PartialType } from '@nestjs/swagger';
import { CreateScrapeLogDto } from './create-scrape-log.dto';

export class UpdateScrapeLogDto extends PartialType(CreateScrapeLogDto) {}
