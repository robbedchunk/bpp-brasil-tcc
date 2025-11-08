import { ApiProperty } from '@nestjs/swagger'
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Length,
} from 'class-validator'

export class CreateFxRateDto {
  @ApiProperty({
    example: '2025-11-04',
    description: 'Date of the FX rate (YYYY-MM-DD)',
  })
  @IsDateString()
  day: string

  @ApiProperty({ example: 'USD', description: 'Base currency (3-letter ISO)' })
  @IsString()
  @Length(3, 3)
  baseCurrency: string

  @ApiProperty({ example: 'EUR', description: 'Quote currency (3-letter ISO)' })
  @IsString()
  @Length(3, 3)
  quoteCurrency: string

  @ApiProperty({
    example: 0.9123,
    description: 'Exchange rate (quote per base)',
  })
  @IsNumber()
  rate: number

  @ApiProperty({
    example: 'ECB',
    required: false,
    description: 'Source of the FX data',
  })
  @IsOptional()
  @IsString()
  source?: string | null

  @ApiProperty({ example: { fetchedFrom: 'ECB API' }, required: false })
  @IsOptional()
  meta?: Record<string, any> | null
}
