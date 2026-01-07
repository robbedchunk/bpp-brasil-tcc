import { ApiProperty } from '@nestjs/swagger'
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Length,
} from 'class-validator'

export class DailyMarketIndex {
  @ApiProperty({
    example: '2025-11-04',
    description: 'Date of index (YYYY-MM-DD)',
  })
  @IsDateString()
  day: string | null

  @ApiProperty({
    example: 'US',
    required: false,
    description: 'ISO 2-letter country code',
  })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string | null

  @ApiProperty({
    example: '10001',
    required: false,
    description: 'Zip/postal code (optional)',
  })
  @IsOptional()
  @IsString()
  @Length(1, 20)
  zipCode?: string | null

  @ApiProperty({
    example: 102.35,
    required: false,
    description: 'Index level (base=100)',
  })
  @IsOptional()
  @IsNumber()
  indexLevel?: number | null

  @ApiProperty({
    example: 'geometric',
    required: false,
    description: 'Computation method',
  })
  @IsOptional()
  @IsString()
  method?: string | null

  @ApiProperty({
    example: { items: 540 },
    required: false,
    description: 'Meta information JSON',
  })
  @IsOptional()
  meta?: Record<string, any> | null
}
