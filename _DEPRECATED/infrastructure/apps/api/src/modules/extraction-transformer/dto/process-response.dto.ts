import { ApiProperty } from '@nestjs/swagger'

export class ProcessResponseDto {
  @ApiProperty({ example: 'product', description: 'Detected page type' })
  pageType: 'category' | 'product' | 'unknown'

  @ApiProperty({ example: 'Nike Air Max 270', required: false })
  title?: string

  @ApiProperty({ example: 129.99, required: false })
  price?: number

  @ApiProperty({ example: 'USD', required: false })
  currency?: string

  @ApiProperty({ example: ['https://store.com/men'], required: false })
  links?: string[]

  @ApiProperty({ example: { confidence: 0.93 } })
  metadata?: Record<string, any>
}
