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
import { DailyPriceAggregateService } from './daily-price-aggregate.service'
import { DailyPriceAggregate } from '../../database/entities/daily-price-aggregate.entity'
import { CreateDailyPriceAggregateDto } from './dto/create-daily-price-aggregate.dto'
import { UpdateDailyPriceAggregateDto } from './dto/update-daily-price-aggregate.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('DailyPriceAggregates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('daily-price-aggregates')
export class DailyPriceAggregateController {
  constructor (private readonly service: DailyPriceAggregateService) {}

  @Get()
  @ApiOperation({ summary: 'List daily price aggregates' })
  @ApiResponse({ status: 200, type: [DailyPriceAggregate] })
  findAll (): Promise<DailyPriceAggregate[]> {
    return this.service.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific daily price aggregate record' })
  @ApiResponse({ status: 200, type: DailyPriceAggregate })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<DailyPriceAggregate> {
    return this.service.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new daily price aggregate record' })
  @ApiResponse({ status: 201, type: DailyPriceAggregate })
  create (
    @Body() data: CreateDailyPriceAggregateDto,
  ): Promise<DailyPriceAggregate> {
    return this.service.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing daily price aggregate record' })
  @ApiResponse({ status: 200, type: DailyPriceAggregate })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateDailyPriceAggregateDto,
  ): Promise<DailyPriceAggregate> {
    return this.service.update(id, data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a daily price aggregate record' })
  @ApiResponse({ status: 200, description: 'Record deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id)
  }
}
