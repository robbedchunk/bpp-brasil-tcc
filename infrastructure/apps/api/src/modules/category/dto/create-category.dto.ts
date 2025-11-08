import { ApiProperty } from '@nestjs/swagger'
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Length,
} from 'class-validator'

export class CreateCategoryDto {
  @ApiProperty({ example: 'Smartphones', description: 'Category name' })
  @IsString()
  @Length(2, 100)
  name: string

  @ApiProperty({
    example: 1,
    description: 'Store ID to which the category belongs',
  })
  @IsNumber()
  storeId: number

  @ApiProperty({
    example: 5,
    required: false,
    description: 'Parent category ID (for nested categories)',
  })
  @IsOptional()
  @IsNumber()
  parentId?: number | null

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean
}
