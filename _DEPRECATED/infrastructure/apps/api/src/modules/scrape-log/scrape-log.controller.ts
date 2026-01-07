import {
  Controller,
  Get,
  Post,
  Put,
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
} from '@nestjs/swagger'
import { ScrapeLogService } from './scrape-log.service'
import { ScrapeLog } from '../../database/entities/scrape-log.entity'
import { CreateScrapeLogDto } from './dto/create-scrape-log.dto'
import { UpdateScrapeLogDto } from './dto/update-scrape-log.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('ScrapeLogs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('scrape-logs')
export class ScrapeLogController {
  constructor (private readonly scrapeLogService: ScrapeLogService) {}

  @Get()
  @ApiOperation({ summary: 'List all scrape logs' })
  @ApiResponse({
    status: 200,
    description: 'List of scrape logs',
    type: [ScrapeLog],
  })
  findAll (): Promise<ScrapeLog[]> {
    return this.scrapeLogService.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a scrape log by ID' })
  @ApiResponse({
    status: 200,
    description: 'Scrape log found',
    type: ScrapeLog,
  })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<ScrapeLog> {
    return this.scrapeLogService.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new scrape log' })
  @ApiResponse({
    status: 201,
    description: 'Scrape log created',
    type: ScrapeLog,
  })
  create (@Body() data: CreateScrapeLogDto): Promise<ScrapeLog> {
    return this.scrapeLogService.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing scrape log' })
  @ApiResponse({
    status: 200,
    description: 'Scrape log updated',
    type: ScrapeLog,
  })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateScrapeLogDto,
  ): Promise<ScrapeLog> {
    return this.scrapeLogService.update(id, data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a scrape log' })
  @ApiResponse({ status: 200, description: 'Scrape log deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.scrapeLogService.remove(id)
  }
}
