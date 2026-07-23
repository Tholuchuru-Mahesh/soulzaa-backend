import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  VIDEO_ROOM_RANKING_DEFAULT_PAGE_SIZE,
  VIDEO_ROOM_RANKING_MAX_PAGE_SIZE,
  VideoRoomRankingDimension,
} from '../constants/video-room-ranking.constants';

/**
 * VR-13 ranking DTOs.
 *
 * `QueryRankingDto` is shared across every GET route in
 * `VideoRoomsRankingsController`. On the dimension-specific routes
 * (`/rankings/hosts`, `/rankings/gifters`, ...) the `dimension` field is
 * ignored — the route itself is the source of truth for what is ranked.
 */
export enum RankingPeriodDto {
  HOURLY = 'hourly',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  YEARLY = 'yearly',
  ALLTIME = 'alltime',
}

export enum RankingAudienceDto {
  ALL = 'all',
  FRIENDS = 'friends',
  FOLLOWING = 'following',
}

export class QueryRankingDto {
  @ApiPropertyOptional({
    enum: VideoRoomRankingDimension,
    default: VideoRoomRankingDimension.HOSTS,
    description: 'What is being ranked. Ignored by the dimension-specific routes.',
  })
  @IsOptional()
  @IsEnum(VideoRoomRankingDimension)
  dimension: VideoRoomRankingDimension = VideoRoomRankingDimension.HOSTS;

  @ApiPropertyOptional({ enum: RankingPeriodDto, default: RankingPeriodDto.DAILY })
  @IsOptional()
  @IsEnum(RankingPeriodDto)
  period: RankingPeriodDto = RankingPeriodDto.DAILY;

  @ApiPropertyOptional({
    example: '20260722',
    description:
      'Window to read. Omit for the current window. Formats: hourly YYYYMMDDHH, ' +
      'daily YYYYMMDD, weekly YYYYWww, monthly YYYYMM, quarterly YYYYQq, yearly YYYY. ' +
      'Forbidden for guests.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(\d{4,10}|\d{4}W\d{2}|\d{4}Q[1-4]|alltime)$/, {
    message: 'dateKey is not a recognised period key',
  })
  dateKey?: string;

  @ApiPropertyOptional({ example: 'IN', description: 'ISO-3166 alpha-2. Country routes only.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be an ISO-3166 alpha-2 code' })
  country?: string;

  @ApiPropertyOptional({ description: 'City id. Narrows the ladder to one city.', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({
    enum: RankingAudienceDto,
    default: RankingAudienceDto.ALL,
    description: 'Project onto your friends or followers instead of everyone.',
  })
  @IsOptional()
  @IsEnum(RankingAudienceDto)
  audience: RankingAudienceDto = RankingAudienceDto.ALL;

  @ApiPropertyOptional({
    default: VIDEO_ROOM_RANKING_DEFAULT_PAGE_SIZE,
    maximum: VIDEO_ROOM_RANKING_MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VIDEO_ROOM_RANKING_MAX_PAGE_SIZE)
  limit: number = VIDEO_ROOM_RANKING_DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({ default: 1, description: 'Guests may only read page 1.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}

export class RankingEntryResponseDto {
  @ApiProperty({ example: 1, description: '1-based, continuous across pages.' })
  rank!: number;

  @ApiProperty({ description: 'User id, or room id on the `rooms` dimension.' })
  targetId!: string;

  @ApiProperty({ example: 'alice' })
  username!: string;

  @ApiProperty({ nullable: true, example: 'avatars/alice.png' })
  avatarKey!: string | null;

  @ApiProperty({ example: 128_400, description: 'Composite score for this dimension.' })
  score!: number;

  @ApiProperty({ example: 12 })
  level!: number;

  @ApiProperty({ example: 3 })
  vipLevel!: number;
}

export class LeaderboardResponseDto {
  @ApiProperty({ type: [RankingEntryResponseDto] })
  items!: RankingEntryResponseDto[];

  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 4_812 }) total!: number;
  @ApiProperty({ example: 241 }) totalPages!: number;
}

export class SelfRankResponseDto {
  @ApiProperty({ enum: VideoRoomRankingDimension }) dimension!: string;
  @ApiProperty({ example: 'daily' }) period!: string;
  @ApiProperty({ example: '20260722' }) dateKey!: string;

  @ApiProperty({ nullable: true, example: 482, description: 'Null when unranked.' })
  rank!: number | null;

  @ApiProperty({ example: 9_100 }) score!: number;
}

export class RankingHistoryResponseDto {
  @ApiProperty({ example: '20260721' }) dateKey!: string;
  @ApiProperty({ example: 12 }) rank!: number;
  @ApiProperty({ example: 88_000 }) score!: number;
}
