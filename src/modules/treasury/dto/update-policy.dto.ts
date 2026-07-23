import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class UpdateFinancialPolicyDto {
  @ApiProperty({ description: 'New policy limit value (in base coins)', example: 1000000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsNotEmpty()
  value!: number;

  @ApiPropertyOptional({ description: 'Optional reason for policy change' })
  @IsString()
  @IsOptional()
  reason?: string;
}
