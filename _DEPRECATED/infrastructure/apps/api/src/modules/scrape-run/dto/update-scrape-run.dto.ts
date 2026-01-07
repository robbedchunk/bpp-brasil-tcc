import { PartialType } from '@nestjs/swagger';
import { CreateScrapeRunDto } from './create-scrape-run.dto';

export class UpdateScrapeRunDto extends PartialType(CreateScrapeRunDto) {}
