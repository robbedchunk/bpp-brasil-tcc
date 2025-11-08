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
import { PriceObservationService } from './price-observation.service'
import { PriceObservation } from '../../database/entities/price-observation.entity'
import { CreatePriceObservationDto } from './dto/create-price-observation.dto'
import { UpdatePriceObservationDto } from './dto/update-price-observation.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('PriceObservations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('price-observations')
export class PriceObservationController {
  constructor (private readonly service: PriceObservationService) {}

  @Get()
  @ApiOperation({ summary: 'List recent price observations' })
  @ApiResponse({
    status: 200,
    description: 'List of price observations',
    type: [PriceObservation],
  })
  findAll (): Promise<PriceObservation[]> {
    return this.service.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single price observation by ID' })
  @ApiResponse({
    status: 200,
    description: 'Observation found',
    type: PriceObservation,
  })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<PriceObservation> {
    return this.service.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new price observation' })
  @ApiResponse({
    status: 201,
    description: 'Observation created',
    type: PriceObservation,
  })
  create (@Body() data: CreatePriceObservationDto): Promise<PriceObservation> {
    return this.service.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing price observation' })
  @ApiResponse({
    status: 200,
    description: 'Observation updated',
    type: PriceObservation,
  })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdatePriceObservationDto,
  ): Promise<PriceObservation> {
    return this.service.update(id, data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a price observation' })
  @ApiResponse({ status: 200, description: 'Observation deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id)
  }
}
