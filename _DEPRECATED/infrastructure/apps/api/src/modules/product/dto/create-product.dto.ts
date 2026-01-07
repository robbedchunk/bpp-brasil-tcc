import { ApiProperty } from '@nestjs/swagger'
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
} from 'class-validator'

export class CreateProductDto {
  @ApiProperty({ example: 1, description: 'Store ID that owns this product' })
  @IsNumber()
  storeId: number

  @ApiProperty({ example: 2, description: 'Category ID' })
  @IsNumber()
  categoryId: number

  @ApiProperty({
    example: 3,
    required: false,
    description: 'Brand ID (optional)',
  })
  @IsOptional()
  @IsNumber()
  brandId?: number | null

  @ApiProperty({ example: 'iPhone 15', description: 'Product name' })
  @IsString()
  @Length(2, 200)
  name: string

  @ApiProperty({ example: 'iPhone 15 Pro Max', required: false })
  @IsOptional()
  @IsString()
  canonicalName?: string | null

  @ApiProperty({ example: ['Apple iPhone 15', 'iPhone XV'], required: false })
  @IsOptional()
  @IsArray()
  alternateNames?: string[] | null

  @ApiProperty({ example: 'Newest Apple smartphone', required: false })
  @IsOptional()
  @IsString()
  description?: string | null

  @ApiProperty({ example: 1, required: false })
  @IsOptional()
  @IsNumber()
  quantityValue?: number | null

  @ApiProperty({ example: 'each', required: false })
  @IsOptional()
  @IsString()
  quantityUnit?: string | null

  @ApiProperty({ example: 'https://example.com/image.jpg', required: false })
  @IsOptional()
  @IsUrl()
  imageUrl?: string | null

  @ApiProperty({
    example: 'https://store.com/product/iphone15',
    required: false,
  })
  @IsOptional()
  @IsUrl()
  productUrl?: string | null
}
