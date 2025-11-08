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
import { ProductLinkService } from './product-link.service'
import { ProductLink } from '../../database/entities/product-link.entity'
import { CreateProductLinkDto } from './dto/create-product-link.dto'
import { UpdateProductLinkDto } from './dto/update-product-link.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('ProductLinks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('product-links')
export class ProductLinkController {
  constructor (private readonly productLinkService: ProductLinkService) {}

  @Get()
  @ApiOperation({ summary: 'List all product links' })
  @ApiResponse({
    status: 200,
    description: 'List of product links',
    type: [ProductLink],
  })
  findAll (): Promise<ProductLink[]> {
    return this.productLinkService.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a product link by ID' })
  @ApiResponse({
    status: 200,
    description: 'Product link found',
    type: ProductLink,
  })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<ProductLink> {
    return this.productLinkService.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new product link' })
  @ApiResponse({
    status: 201,
    description: 'Product link created',
    type: ProductLink,
  })
  create (@Body() data: CreateProductLinkDto): Promise<ProductLink> {
    return this.productLinkService.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a product link' })
  @ApiResponse({
    status: 200,
    description: 'Product link updated',
    type: ProductLink,
  })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateProductLinkDto,
  ): Promise<ProductLink> {
    return this.productLinkService.update(id, data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a product link' })
  @ApiResponse({ status: 200, description: 'Product link deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.productLinkService.remove(id)
  }
}
