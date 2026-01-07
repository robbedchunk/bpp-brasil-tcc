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
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { RegionService } from './region.service';
import { Region } from '../../database/entities/region.entity';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('Regions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('regions')
export class RegionController {
  constructor(private readonly regionService: RegionService) {}

  @Get()
  @ApiOperation({ summary: 'List all regions' })
  @ApiResponse({ status: 200, description: 'List of regions', type: [Region] })
  findAll(): Promise<Region[]> {
    return this.regionService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single region by ID' })
  @ApiResponse({ status: 200, description: 'Region found', type: Region })
  findOne(@Param('id', ParseIntPipe) id: number): Promise<Region> {
    return this.regionService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new region' })
  @ApiResponse({ status: 201, description: 'Region created', type: Region })
  create(@Body() data: CreateRegionDto): Promise<Region> {
    return this.regionService.create(data);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing region' })
  @ApiResponse({ status: 200, description: 'Region updated', type: Region })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateRegionDto,
  ): Promise<Region> {
    return this.regionService.update(id, data);
  } 

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a region' })
  @ApiResponse({ status: 200, description: 'Region deleted' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.regionService.remove(id);
  }
}
