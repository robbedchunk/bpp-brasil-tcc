import { IsInt, IsArray, IsString } from 'class-validator';

export class LinksDto {
  @IsInt()
  storeId: number;

  @IsInt()
  parentJobId: number;

  @IsArray()
  @IsString({ each: true })
  links: string[];
}
