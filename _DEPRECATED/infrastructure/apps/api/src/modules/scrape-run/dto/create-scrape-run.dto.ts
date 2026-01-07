import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';

export enum ScrapeRunStatus {
  CREATED = 'created',
  RUNNING = 'running',
  FINISHED = 'finished',
  FAILED = 'failed',
}

export class CreateScrapeRunDto {
  @ApiProperty({ example: 'created', enum: ScrapeRunStatus })
  @IsEnum(ScrapeRunStatus)
  status: ScrapeRunStatus;

  @ApiProperty({ example: 'system', required: false, description: 'Who initiated this scrape run' })
  @IsOptional()
  @IsString()
  initiatedBy?: string | null;

  @ApiProperty({
    example: { totalScrapes: 0, errors: 0 },
    required: false,
    description: 'Optional run statistics',
  })
  @IsOptional()
  @IsObject()
  stats?: Record<string, any> | null;
}
