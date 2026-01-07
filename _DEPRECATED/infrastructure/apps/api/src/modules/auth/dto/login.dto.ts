import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin', description: 'Username for authentication' })
  @IsString()
  @Length(3, 50)
  username: string;

  @ApiProperty({ example: 'admin', description: 'Password for authentication' })
  @IsString()
  @Length(3, 50)
  password: string;
}
