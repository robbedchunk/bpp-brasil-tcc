import { Controller, Post, Body, UseGuards } from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger'
import { ExtractionTransformerService } from './extraction-transformer.service'
import { ProcessRequestDto } from './dto/process-request.dto'
import { ProcessResponseDto } from './dto/process-response.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('ExtractionTransformer')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transformer')
export class ExtractionTransformerController {
  constructor (private readonly service: ExtractionTransformerService) {}

  @Post('process')
  @ApiOperation({
    summary: 'Analyze raw scraped HTML and classify it (category/product)',
  })
  @ApiResponse({ status: 200, type: ProcessResponseDto })
  async process (@Body() body: ProcessRequestDto): Promise<ProcessResponseDto> {
    return this.service.process(body)
  }
}
