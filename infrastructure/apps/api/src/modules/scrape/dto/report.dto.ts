import { IsInt, IsString, IsOptional, IsBoolean } from 'class-validator';

export class ReportDto {
  @IsInt()
  jobId: number;

  @IsString()
  url: string;

  @IsOptional()
  @IsString()
  html?: string;

  @IsOptional()
  @IsBoolean()
  success?: boolean;

  @IsOptional()
  @IsString()
  errorMessage?: string;
}
