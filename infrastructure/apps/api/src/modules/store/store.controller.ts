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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StoreService } from './store.service';
import { Store } from '../../database/entities/store.entity';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('Stores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stores')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Get()
  @ApiOperation({ summary: 'List all stores' })
  @ApiResponse({ status: 200, description: 'List of stores', type: [Store] })
  findAll(): Promise<Store[]> {
    return this.storeService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single store by ID' })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  findOne(@Param('id', ParseIntPipe) id: number): Promise<Store> {
    return this.storeService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new store' })
  @ApiResponse({ status: 201, description: 'Store created', type: Store })
  create(@Body() data: CreateStoreDto): Promise<Store> {
    return this.storeService.create(data);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing store' })
  @ApiResponse({ status: 200, description: 'Store updated', type: Store })
  update(@Param('id', ParseIntPipe) id: number, @Body() data: UpdateStoreDto): Promise<Store> {
    return this.storeService.update(id, data);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a store' })
  @ApiResponse({ status: 200, description: 'Store deleted' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.storeService.remove(id);
  }
}
