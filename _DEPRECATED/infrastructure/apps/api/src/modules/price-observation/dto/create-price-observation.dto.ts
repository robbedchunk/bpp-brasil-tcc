import { ApiProperty } from '@nestjs/swagger'
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator'

export class CreatePriceObservationDto {
  @ApiProperty({ example: 1, description: 'Product ID' })
  @IsNumber()
  productId: number | null

  @ApiProperty({
    example: 2,
    required: false,
    description: 'Region ID (optional)',
  })
  @IsOptional()
  @IsNumber()
  regionId?: number | null

  @ApiProperty({ example: 123.45, description: 'Observed price' })
  @IsNumber()
  price: number | null

  @ApiProperty({ example: 'USD', description: 'ISO currency code' })
  @IsString()
  @Length(3, 3)
  currency: string | null

  @ApiProperty({
    example: true,
    required: false,
    description: 'Availability flag',
  })
  @IsOptional()
  @IsBoolean()
  availability?: boolean | null

  @ApiProperty({
    example: 10,
    required: false,
    description: 'Scrape ID (origin of observation)',
  })
  @IsOptional()
  @IsNumber()
  scrapeId?: number | null

  @ApiProperty({
    example: '2025-11-04T22:40:00.000Z',
    required: false,
    description: 'Observation timestamp',
  })
  @IsOptional()
  @IsString()
  observedAt?: string | null

  @ApiProperty({
    example: 'https://store.com/p/123',
    required: false,
    description: 'Source URL used for this observation',
  })
  @IsOptional()
  @IsString()
  sourceUrl?: string | null

  @ApiProperty({
    example: 'v1.2.3',
    required: false,
    description: 'Extractor config version',
  })
  @IsOptional()
  @IsString()
  configVersion?: string | null
}
