import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

const PERIODS = ['today', 'week', 'month', 'all'] as const;

export class TopFansQueryDto {
  @ApiPropertyOptional({ enum: PERIODS, default: 'all' })
  @IsOptional()
  @IsIn(PERIODS)
  period: 'today' | 'week' | 'month' | 'all' = 'all';

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
