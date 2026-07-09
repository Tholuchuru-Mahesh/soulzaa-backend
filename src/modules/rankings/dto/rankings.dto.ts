import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum RankingPeriod {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  ALLTIME = 'alltime',
}

export class QueryRankingsDto {
  @ApiProperty({
    description: 'The time period for rankings',
    enum: RankingPeriod,
    default: RankingPeriod.DAILY,
  })
  @IsEnum(RankingPeriod)
  @IsOptional()
  period: RankingPeriod = RankingPeriod.DAILY;

  @ApiPropertyOptional({
    description: 'Number of records to fetch (max 100)',
    default: 50,
    minimum: 1,
    maximum: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 50;

  @ApiPropertyOptional({ description: 'Page number for pagination', default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;
}

export interface RankedGifter {
  rank: number;
  userId: string;
  username: string;
  fullName: string | null;
  avatarKey: string | null;
  score: number;
  level: number;
  vipLevel: number;
}

export interface RankedReceiver {
  rank: number;
  userId: string;
  username: string;
  fullName: string | null;
  avatarKey: string | null;
  score: number;
  level: number;
  vipLevel: number;
}

export interface RankedFamily {
  rank: number;
  familyId: string;
  name: string;
  logoKey: string | null;
  score: number;
  level: number;
  leaderUsername: string;
}

export interface RankedStreamer {
  rank: number;
  userId: string;
  username: string;
  fullName: string | null;
  avatarKey: string | null;
  score: number;
  level: number;
  vipLevel: number;
}
