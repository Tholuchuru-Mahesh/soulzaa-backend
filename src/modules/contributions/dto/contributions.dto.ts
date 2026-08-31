import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

export type ContributionScope = 'room' | 'user';

const WEEK_KEY = /^\d{4}W\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

/** GET /admin/contributions/weekly — one entity's totals for a week (+ prev week). */
export class WeeklyContributionQueryDto {
  @ApiProperty({ enum: ['room', 'user'] })
  @IsEnum({ room: 'room', user: 'user' })
  scope!: ContributionScope;

  @ApiProperty({ description: 'Room id (scope=room) or user id (scope=user).' })
  @IsUUID()
  id!: string;

  @ApiPropertyOptional({
    description: 'ISO week key, e.g. "2026W36". Defaults to the current week.',
  })
  @IsOptional()
  @Matches(WEEK_KEY, { message: 'weekKey must look like 2026W36' })
  weekKey?: string;
}

/** GET /admin/contributions/history — week-wise or month-rolled history. */
export class ContributionHistoryQueryDto extends PaginationQueryDto {
  @ApiProperty({ enum: ['room', 'user'] })
  @IsEnum({ room: 'room', user: 'user' })
  scope!: ContributionScope;

  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiPropertyOptional({ enum: ['week', 'month'], default: 'week' })
  @IsOptional()
  @IsIn(['week', 'month'])
  granularity: 'week' | 'month' = 'week';

  @ApiPropertyOptional({ description: 'From week key ("2026W01") or month key ("2026-01").' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'To week key / month key (inclusive).' })
  @IsOptional()
  @IsString()
  to?: string;
}

/** GET /admin/contributions/leaderboard — top rooms / users for one week. */
export class ContributionLeaderboardQueryDto {
  @ApiProperty({ enum: ['room', 'user'] })
  @IsEnum({ room: 'room', user: 'user' })
  scope!: ContributionScope;

  @ApiPropertyOptional({ description: 'ISO week key. Defaults to the current week.' })
  @IsOptional()
  @Matches(WEEK_KEY, { message: 'weekKey must look like 2026W36' })
  weekKey?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export const CONTRIBUTION_KEY_PATTERNS = { WEEK_KEY, MONTH_KEY };
