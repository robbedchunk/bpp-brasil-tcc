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
import { ProductService } from './product.service'
import { Product } from '../../database/entities/product.entity'
import { CreateProductDto } from './dto/create-product.dto'
import { UpdateProductDto } from './dto/update-product.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('Products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductController {
  constructor (private readonly productService: ProductService) {}

  @Get()
  @ApiOperation({ summary: 'List all products' })
  @ApiResponse({
    status: 200,
    description: 'List of products',
    type: [Product],
  })
  findAll (): Promise<Product[]> {
    return this.productService.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a product by ID' })
  @ApiResponse({ status: 200, description: 'Product found', type: Product })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<Product> {
    return this.productService.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new product' })
  @ApiResponse({ status: 201, description: 'Product created', type: Product })
  create (@Body() data: CreateProductDto): Promise<Product> {
    return this.productService.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing product' })
  @ApiResponse({ status: 200, description: 'Product updated', type: Product })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateProductDto,
  ): Promise<Product> {
    return this.productService.update(id, data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a product' })
  @ApiResponse({ status: 200, description: 'Product deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.productService.remove(id)
  }
}
