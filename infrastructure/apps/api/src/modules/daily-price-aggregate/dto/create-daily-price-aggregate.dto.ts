import { ApiProperty } from '@nestjs/swagger'
import { IsDateString, IsNumber, IsOptional } from 'class-validator'

export class CreateDailyPriceAggregateDto {
  @ApiProperty({
    example: '2025-11-04',
    description: 'Date of aggregation (YYYY-MM-DD)',
  })
  @IsDateString()
  day: string

  @ApiProperty({
    example: 1,
    required: false,
    description: 'Region ID (optional)',
  })
  @IsOptional()
  @IsNumber()
  regionId?: number | null

  @ApiProperty({
    example: 2,
    required: false,
    description: 'Category ID (optional)',
  })
  @IsOptional()
  @IsNumber()
  categoryId?: number | null

  @ApiProperty({
    example: 25.6,
    required: false,
    description: 'Average price for this group',
  })
  @IsOptional()
  @IsNumber()
  avgPrice?: number | null

  @ApiProperty({ example: 5.0, required: false })
  @IsOptional()
  @IsNumber()
  minPrice?: number | null

  @ApiProperty({ example: 48.99, required: false })
  @IsOptional()
  @IsNumber()
  maxPrice?: number | null

  @ApiProperty({
    example: 125,
    required: false,
    description: 'Number of items included',
  })
  @IsOptional()
  @IsNumber()
  itemCount?: number | null

  @ApiProperty({ example: { weighted: true }, required: false })
  @IsOptional()
  meta?: Record<string, any> | null
}
