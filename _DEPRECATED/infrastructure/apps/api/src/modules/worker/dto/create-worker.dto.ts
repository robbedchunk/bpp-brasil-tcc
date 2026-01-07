import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIP, IsOptional, IsString } from 'class-validator';

export class CreateWorkerDto {
  @ApiProperty({ example: 'worker-1', description: 'Unique worker name or ID' })
  @IsString()
  workerName: string;

  @ApiProperty({ example: '192.168.1.5', description: 'Worker IP address' })
  @IsIP()
  ip: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isAlive?: boolean;
}
