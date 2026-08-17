import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import type { GrowthRange } from '../interfaces/agency-dashboard.interface';

const GROWTH_RANGES: readonly GrowthRange[] = ['week', 'month', 'quarter'];

export class AgencyGrowthQueryDto {
  @ApiPropertyOptional({
    enum: GROWTH_RANGES,
    default: 'month',
    description: 'Trailing window the chart plots: 7, 30 or 90 daily points.',
  })
  @IsOptional()
  @IsIn(GROWTH_RANGES)
  range: GrowthRange = 'month';
}

const LEADERBOARD_RANGES = ['daily', 'weekly', 'monthly'] as const;

/** Query for `GET /agencies/me/leaderboard`. */
export class AgencyLeaderboardQueryDto {
  @ApiPropertyOptional({ enum: LEADERBOARD_RANGES, default: 'monthly' })
  @IsOptional()
  @IsIn(LEADERBOARD_RANGES)
  range?: (typeof LEADERBOARD_RANGES)[number];

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
