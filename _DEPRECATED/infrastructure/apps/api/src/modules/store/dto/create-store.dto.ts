import { ApiProperty } from '@nestjs/swagger'
import { IsBoolean, IsOptional, IsString, IsUrl, Length } from 'class-validator'

export class CreateStoreDto {
  @ApiProperty({ example: 'Walmart', description: 'Store name' })
  @IsString()
  @Length(2, 100)
  name: string

  @ApiProperty({ example: 'walmart.com', required: false })
  @IsOptional()
  @IsString()
  domain?: string | null

  @ApiProperty({ example: 'https://www.walmart.com', required: false })
  @IsOptional()
  @IsUrl()
  baseUrl?: string | null

  @ApiProperty({ example: 'US', description: 'ISO country code' })
  @IsString()
  @Length(2, 2)
  countryCode: string

  @ApiProperty({
    example: 'online',
    enum: ['online', 'offline', 'omnichannel'],
  })
  @IsString()
  channel: string

  @ApiProperty({ example: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean
}
