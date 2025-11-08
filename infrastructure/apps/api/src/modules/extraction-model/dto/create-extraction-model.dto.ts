import { ApiProperty } from '@nestjs/swagger'
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator'

export class CreateExtractionModelDto {
  @ApiProperty({
    example: 'openai:gpt-4o',
    description: 'Model identifier or name',
  })
  @IsString()
  @Length(2, 100)
  name: string | null

  @ApiProperty({ example: 'v1.0', description: 'Version string' })
  @IsString()
  @Length(1, 50)
  version: string | null

  @ApiProperty({
    example: { temperature: 0.2, max_tokens: 500 },
    required: false,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, any> | null

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean | null
}
