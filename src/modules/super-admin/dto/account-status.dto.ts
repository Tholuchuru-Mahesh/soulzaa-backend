import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class SuspendAccountDto {
  @ApiPropertyOptional({
    description: 'Reason for suspension',
    example: 'Terms of service violation',
  })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({ description: 'Optional duration in days for suspension' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  durationDays?: number;
}

export class LockAccountDto {
  @ApiPropertyOptional({
    description: 'Reason for locking account',
    example: 'Suspicious security activity',
  })
  @IsString()
  @IsOptional()
  reason?: string;
}
