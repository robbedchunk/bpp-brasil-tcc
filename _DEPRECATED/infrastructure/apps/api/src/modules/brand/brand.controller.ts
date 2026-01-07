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
import { BrandService } from './brand.service'
import { Brand } from '../../database/entities/brand.entity'
import { CreateBrandDto } from './dto/create-brand.dto'
import { UpdateBrandDto } from './dto/update-brand.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('Brands')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('brands')
export class BrandController {
  constructor (private readonly brandService: BrandService) {}

  @Get()
  @ApiOperation({ summary: 'List all brands' })
  @ApiResponse({ status: 200, description: 'List of brands', type: [Brand] })
  findAll (): Promise<Brand[]> {
    return this.brandService.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a brand by ID' })
  @ApiResponse({ status: 200, description: 'Brand found', type: Brand })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<Brand> {
    return this.brandService.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new brand' })
  @ApiResponse({ status: 201, description: 'Brand created', type: Brand })
  create (@Body() data: CreateBrandDto): Promise<Brand> {
    return this.brandService.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing brand' })
  @ApiResponse({ status: 200, description: 'Brand updated', type: Brand })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateBrandDto,
  ): Promise<Brand> {
    return this.brandService.update(id, data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a brand' })
  @ApiResponse({ status: 200, description: 'Brand deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.brandService.remove(id)
  }
}
