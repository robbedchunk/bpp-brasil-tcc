import { PartialType } from '@nestjs/swagger';
import { CreateProductLinkDto } from './create-product-link.dto';

export class UpdateProductLinkDto extends PartialType(CreateProductLinkDto) {}
