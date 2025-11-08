import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger'
import { ScrapeService } from './scrape.service'
import { Scrape } from '../../database/entities/scrape.entity'
import { CreateScrapeDto } from './dto/create-scrape.dto'
import { UpdateScrapeDto } from './dto/update-scrape.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

class FinishScrapeDto {
  success: boolean
  error?: string | null
}

@ApiTags('Scrapes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('scrapes')
export class ScrapeController {
  constructor (private readonly scrapeService: ScrapeService) {}

  @Get()
  @ApiOperation({ summary: 'List all scrape jobs' })
  @ApiResponse({ status: 200, description: 'List of scrapes', type: [Scrape] })
  findAll (): Promise<Scrape[]> {
    return this.scrapeService.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a scrape job by ID' })
  @ApiResponse({ status: 200, description: 'Scrape found', type: Scrape })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<Scrape> {
    return this.scrapeService.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new scrape job' })
  @ApiResponse({ status: 201, description: 'Scrape created', type: Scrape })
  create (@Body() data: CreateScrapeDto): Promise<Scrape> {
    return this.scrapeService.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing scrape job' })
  @ApiResponse({ status: 200, description: 'Scrape updated', type: Scrape })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateScrapeDto,
  ): Promise<Scrape> {
    return this.scrapeService.update(id, data)
  }

  @Patch(':id/finish')
  @ApiOperation({ summary: 'Mark a scrape job finished (success or error)' })
  @ApiBody({
    schema: {
      example: { success: true, error: null },
    },
  })
  @ApiResponse({ status: 200, description: 'Scrape finished', type: Scrape })
  finish (
    @Param('id', ParseIntPipe) id: number,
    @Body() body: FinishScrapeDto,
  ): Promise<Scrape> {
    return this.scrapeService.finish(id, body.success, body.error)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a scrape job' })
  @ApiResponse({ status: 200, description: 'Scrape deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.scrapeService.remove(id)
  }

  // API / Worker
  @Post(':id/queue')
  queueJob (@Param('id', ParseIntPipe) id: number) {
    return this.scrapeService.queueJob(id)
  }

  // Worker / API
  @Post('report')
  handleReport (@Body() body: any) {
    return this.scrapeService.handleWorkerReport(body)
  }
}
