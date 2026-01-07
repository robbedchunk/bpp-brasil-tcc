import { ApiProperty } from '@nestjs/swagger'
import { IsNumber, IsOptional, IsString, Length } from 'class-validator'

export class CreateProductLinkDto {
  @ApiProperty({ example: 1, description: 'Product ID (source product)' })
  @IsNumber()
  productId: number | null

  @ApiProperty({
    example: 2,
    description: 'Linked Product ID (target product)',
  })
  @IsNumber()
  linkedProductId: number | null

  @ApiProperty({
    example: 'equivalent',
    required: false,
    description: 'Link type (equivalent, variant, accessory, etc.)',
  })
  @IsOptional()
  @IsString()
  @Length(2, 50)
  type?: string | null

  @ApiProperty({
    example: 'auto',
    required: false,
    description: 'How the link was created (auto/manual/import)',
  })
  @IsOptional()
  @IsString()
  @Length(2, 50)
  source?: string | null
}
