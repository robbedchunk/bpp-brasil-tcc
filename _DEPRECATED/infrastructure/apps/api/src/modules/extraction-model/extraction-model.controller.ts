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
import { ExtractionModelService } from './extraction-model.service'
import { ExtractionModel } from '../../database/entities/extraction-model.entity'
import { CreateExtractionModelDto } from './dto/create-extraction-model.dto'
import { UpdateExtractionModelDto } from './dto/update-extraction-model.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('ExtractionModels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('extraction-models')
export class ExtractionModelController {
  constructor (
    private readonly extractionModelService: ExtractionModelService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all extraction models' })
  @ApiResponse({
    status: 200,
    description: 'List of models',
    type: [ExtractionModel],
  })
  findAll (): Promise<ExtractionModel[]> {
    return this.extractionModelService.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an extraction model by ID' })
  @ApiResponse({
    status: 200,
    description: 'Model found',
    type: ExtractionModel,
  })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<ExtractionModel> {
    return this.extractionModelService.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new extraction model' })
  @ApiResponse({
    status: 201,
    description: 'Model created',
    type: ExtractionModel,
  })
  create (@Body() data: CreateExtractionModelDto): Promise<ExtractionModel> {
    return this.extractionModelService.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing extraction model' })
  @ApiResponse({
    status: 200,
    description: 'Model updated',
    type: ExtractionModel,
  })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateExtractionModelDto,
  ): Promise<ExtractionModel> {
    return this.extractionModelService.update(id, data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an extraction model' })
  @ApiResponse({ status: 200, description: 'Model deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.extractionModelService.remove(id)
  }
}
