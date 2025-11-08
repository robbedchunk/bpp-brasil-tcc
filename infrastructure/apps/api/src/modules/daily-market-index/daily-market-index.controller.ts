import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger'
import { DailyMarketIndexService } from './daily-market-index.service'
import { DailyMarketIndex } from '../../database/entities/daily-market-index.entity'
import { CreateDailyMarketIndexDto } from './dto/create-daily-market-index.dto'
import { UpdateDailyMarketIndexDto } from './dto/update-daily-market-index.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('DailyMarketIndex')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('daily-market-index')
export class DailyMarketIndexController {
  constructor (private readonly service: DailyMarketIndexService) {}

  @Get()
  @ApiOperation({ summary: 'List all daily market indexes' })
  @ApiResponse({ status: 200, type: [DailyMarketIndex] })
  findAll (): Promise<DailyMarketIndex[]> {
    return this.service.findAll()
  }

  @Get(':day')
  @ApiOperation({ summary: 'Get index by day (and optional country)' })
  @ApiQuery({ name: 'countryCode', required: false })
  @ApiResponse({ status: 200, type: DailyMarketIndex })
  findOne (
    @Param('day') day: string,
    @Query('countryCode') countryCode?: string,
  ): Promise<DailyMarketIndex> {
    return this.service.findOne(day, countryCode)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new daily market index record' })
  @ApiResponse({ status: 201, type: DailyMarketIndex })
  create (@Body() data: CreateDailyMarketIndexDto): Promise<DailyMarketIndex> {
    return this.service.create(data)
  }

  @Put(':day')
  @ApiOperation({ summary: 'Update an existing daily market index record' })
  @ApiQuery({ name: 'countryCode', required: false })
  @ApiResponse({ status: 200, type: DailyMarketIndex })
  update (
    @Param('day') day: string,
    @Query('countryCode') countryCode: string,
    @Body() data: UpdateDailyMarketIndexDto,
  ): Promise<DailyMarketIndex> {
    return this.service.update(day, { ...data, countryCode })
  }

  @Delete(':day')
  @ApiOperation({ summary: 'Delete a daily market index record' })
  @ApiQuery({ name: 'countryCode', required: false })
  @ApiResponse({ status: 200, description: 'Record deleted' })
  remove (
    @Param('day') day: string,
    @Query('countryCode') countryCode?: string,
  ) {
    return this.service.remove(day, countryCode)
  }
}
