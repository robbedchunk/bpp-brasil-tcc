import { ApiProperty } from '@nestjs/swagger'
import { IsOptional, IsString, IsNumber } from 'class-validator'

export class ProcessRequestDto {
  @ApiProperty({ example: '<html>...</html>', description: 'Raw scraped HTML' })
  @IsString()
  rawHtml: string

  @ApiProperty({ example: 1, description: 'Scrape ID', required: false })
  @IsOptional()
  @IsNumber()
  scrapeId?: number

  @ApiProperty({
    example: 'gpt-4o',
    required: false,
    description: 'Extraction model name',
  })
  @IsOptional()
  @IsString()
  model?: string
}
