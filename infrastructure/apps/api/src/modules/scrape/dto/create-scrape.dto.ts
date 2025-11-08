import { ApiProperty } from '@nestjs/swagger'
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsObject,
} from 'class-validator'

export class CreateScrapeDto {
  @ApiProperty({ example: 1, required: false, description: 'Scrape run ID' })
  @IsOptional()
  @IsNumber()
  scrapeRunId?: number | null

  @ApiProperty({ example: 1, description: 'Store ID' })
  @IsNumber()
  storeId: number | null

  @ApiProperty({ example: 10, required: false, description: 'Region ID' })
  @IsOptional()
  @IsNumber()
  regionId?: number | null

  @ApiProperty({
    example: 'product',
    description: 'Job type: category | product | search | frontpage',
  })
  @IsString()
  type: string | null

  @ApiProperty({
    example: 'https://example.com/p/123',
    description: 'Source URL to fetch',
  })
  @IsUrl()
  sourceUrl: string | null

  @ApiProperty({ example: 'queued', required: false })
  @IsOptional()
  @IsString()
  status?: string | null

  @ApiProperty({ example: 'worker-1', required: false })
  @IsOptional()
  @IsString()
  workerId?: string | null

  @ApiProperty({ example: 5, required: false })
  @IsOptional()
  @IsNumber()
  proxyId?: number | null

  @ApiProperty({ example: 'v1.2.3', required: false })
  @IsOptional()
  @IsString()
  configVersion?: string | null

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  weightRequired?: boolean | null

  @ApiProperty({ example: { retries: 0 }, required: false })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any> | null
}
