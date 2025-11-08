import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class CreateRegionDto {
  @ApiProperty({ example: 'California', description: 'Region name' })
  @IsString()
  @Length(2, 100)
  name: string;

  @ApiProperty({ example: 'US', description: 'ISO country code' })
  @IsString()
  @Length(2, 2)
  countryCode: string;

  @ApiProperty({ example: '90001', required: false })
  @IsOptional()
  @IsString()
  zipCode?: string | null;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
