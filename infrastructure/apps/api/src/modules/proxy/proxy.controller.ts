import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
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
import { ProxyService } from './proxy.service'
import { Proxy } from '../../database/entities/proxy.entity'
import { CreateProxyDto } from './dto/create-proxy.dto'
import { UpdateProxyDto } from './dto/update-proxy.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'

@ApiTags('Proxies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('proxies')
export class ProxyController {
  constructor (private readonly proxyService: ProxyService) {}

  @Get()
  @ApiOperation({ summary: 'List all proxies' })
  @ApiResponse({ status: 200, description: 'List of proxies', type: [Proxy] })
  findAll (): Promise<Proxy[]> {
    return this.proxyService.findAll()
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a proxy by ID' })
  @ApiResponse({ status: 200, description: 'Proxy found', type: Proxy })
  findOne (@Param('id', ParseIntPipe) id: number): Promise<Proxy> {
    return this.proxyService.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Create a new proxy' })
  @ApiResponse({ status: 201, description: 'Proxy created', type: Proxy })
  create (@Body() data: CreateProxyDto): Promise<Proxy> {
    return this.proxyService.create(data)
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing proxy' })
  @ApiResponse({ status: 200, description: 'Proxy updated', type: Proxy })
  update (
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateProxyDto,
  ): Promise<Proxy> {
    return this.proxyService.update(id, data)
  }

  @Patch(':id/use')
  @ApiOperation({
    summary: 'Mark a proxy as used (update last_used timestamp)',
  })
  @ApiResponse({ status: 200, description: 'Proxy usage updated', type: Proxy })
  markUsed (@Param('id', ParseIntPipe) id: number): Promise<Proxy> {
    return this.proxyService.markUsed(id)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a proxy' })
  @ApiResponse({ status: 200, description: 'Proxy deleted' })
  remove (@Param('id', ParseIntPipe) id: number) {
    return this.proxyService.remove(id)
  }
}
