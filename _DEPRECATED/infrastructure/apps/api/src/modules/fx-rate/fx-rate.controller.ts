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
import { FxRateService } from './fx-rate.service'
import { FxRate } from '../../database/entities/fx-rate.entity'
import { CreateFxRateDto } from './dto/create-fx-rate.dto'
import { UpdateFxRateDto } from './dto/update-fx-rate.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('FxRates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('fx-rates')
export class FxRateController {
  constructor (private readonly service: FxRateService) {}

  @Get()
  @ApiOperation({ summary: 'List all FX rates' })
  @ApiResponse({ status: 200, type: [FxRate] })
  findAll (): Promise<FxRate[]> {
    return this.service.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get FX rate by ID' })
  @ApiResponse({ status: 200, type: FxRate })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<FxRate> {
    return this.service.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new FX rate entry' })
  @ApiResponse({ status: 201, type: FxRate })
  create (@Body() data: CreateFxRateDto): Promise<FxRate> {
    return this.service.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an FX rate entry' })
  @ApiResponse({ status: 200, type: FxRate })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateFxRateDto,
  ): Promise<FxRate> {
    return this.service.update(id, data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an FX rate entry' })
  @ApiResponse({ status: 200, description: 'FX rate deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id)
  }
}
