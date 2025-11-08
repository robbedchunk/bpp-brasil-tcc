import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsIn, IsIP } from 'class-validator';

export class CreateProxyDto {
  @ApiProperty({ example: '192.168.1.10', description: 'Proxy IP address' })
  @IsString()
  @IsIP()
  ip: string;

  @ApiProperty({ example: 8080, description: 'Proxy port number' })
  @IsInt()
  port: number;

  @ApiProperty({ example: 'user1', required: false })
  @IsOptional()
  @IsString()
  username?: string | null;

  @ApiProperty({ example: 'pass123', required: false })
  @IsOptional()
  @IsString()
  password?: string | null;


  @ApiProperty({ example: 'elite', enum: ['elite', 'anonymous', 'transparent'], required: false })
  @IsOptional()
  @IsIn(['elite', 'anonymous', 'transparent'])
  type?: string | null;
}
