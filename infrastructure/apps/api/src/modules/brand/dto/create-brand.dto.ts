import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateBrandDto {
  @ApiProperty({ example: 'Apple', description: 'Brand name' })
  @IsString()
  @Length(2, 100)
  name: string;

  @ApiProperty({ example: 'apple', required: false })
  @IsOptional()
  @IsString()
  canonical?: string | null;

  @ApiProperty({ example: 'US', required: false })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  origin?: string | null;
}
