import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Param,
  Body,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  /**
   * Creates a new scrape run.
   * @param data - The data of the scrape run to be created.
   * @returns The created scrape run.
   */
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger'
import { ScrapeRunService } from './scrape-run.service'
import { ScrapeRun } from '../../database/entities/scrape-run.entity'
import { CreateScrapeRunDto } from './dto/create-scrape-run.dto'
import { UpdateScrapeRunDto } from './dto/update-scrape-run.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('ScrapeRuns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('scrape-runs')
export class ScrapeRunController {
  constructor (private readonly scrapeRunService: ScrapeRunService) {}

  @Get()
  @ApiOperation({ summary: 'List all scrape runs' })
  @ApiResponse({
    status: 200,
    description: 'List of scrape runs',
    type: [ScrapeRun],
  })
  findAll (): Promise<ScrapeRun[]> {
    return this.scrapeRunService.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a scrape run by ID' })
  @ApiResponse({
    status: 200,
    description: 'Scrape run found',
    type: ScrapeRun,
  })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<ScrapeRun> {
    return this.scrapeRunService.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new scrape run' })
  @ApiResponse({
    status: 201,
    description: 'Scrape run created',
    type: ScrapeRun,
  })
  create (@Body() data: CreateScrapeRunDto): Promise<ScrapeRun> {
    return this.scrapeRunService.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing scrape run' })
  @ApiResponse({
    status: 200,
    description: 'Scrape run updated',
    type: ScrapeRun,
  })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateScrapeRunDto,
  ): Promise<ScrapeRun> {
    return this.scrapeRunService.update(id, data)
  }

  @Patch(':id/finish')
  @ApiOperation({ summary: 'Mark a scrape run as finished' })
  @ApiResponse({
    status: 200,
    description: 'Scrape run marked finished',
    type: ScrapeRun,
  })
  finish (@Param('id', ParseIntPipe) id: number): Promise<ScrapeRun> {
    return this.scrapeRunService.finish(id)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a scrape run' })
  @ApiResponse({ status: 200, description: 'Scrape run deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.scrapeRunService.remove(id)
  }
}
