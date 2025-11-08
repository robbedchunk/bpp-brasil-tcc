import { ApiProperty } from '@nestjs/swagger'
import { IsNumber, IsOptional, IsString, Length } from 'class-validator'

export class CreateScrapeLogDto {
  @ApiProperty({
    example: 1,
    description: 'Scrape ID associated with this log',
  })
  @IsNumber()
  scrapeId: number

  @ApiProperty({
    example: 'info',
    description: 'Log level (info, warning, error)',
  })
  @IsString()
  @Length(3, 20)
  logLevel: string

  @ApiProperty({
    example: 'Fetched successfully',
    description: 'Message for this log entry',
  })
  @IsString()
  @Length(1, 500)
  message: string
}
