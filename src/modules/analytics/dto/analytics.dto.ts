import { ApiPropertyOptional } from '@nestjs/swagger';
import { GiftContextType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { ANALYTICS_DEFAULT_SERIES_DAYS } from '../constants/analytics.constants';

export class QueryRevenueDto {
  @ApiPropertyOptional({ description: 'Start date in YYYYMMDD format', example: '20260701' })
  @IsString()
  @IsOptional()
  @Matches(/^\d{8}$/, { message: 'startDate must be in YYYYMMDD format' })
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date in YYYYMMDD format', example: '20260707' })
  @IsString()
  @IsOptional()
  @Matches(/^\d{8}$/, { message: 'endDate must be in YYYYMMDD format' })
  endDate?: string;

  @ApiPropertyOptional({ description: 'Filter by room ID' })
  @IsUUID()
  @IsOptional()
  roomId?: string;

  @ApiPropertyOptional({ description: 'Filter by creator (receiver) user ID' })
  @IsUUID()
  @IsOptional()
  userId?: string;
}

export interface RoomActivityView {
  roomId: string;
  peakParticipants: number;
  totalJoined: number;
  totalGifts: number;
  totalGiftCoins: string; // Surfaced as string due to BigInt serialization
  totalSpeakingMinutes: number;
  durationSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoomSpeakingView {
  userId: string;
  username: string;
  avatarKey: string | null;
  speakingSeconds: number;
}

export interface RoomAttendanceView {
  userId: string;
  username: string;
  avatarKey: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  durationSeconds: number;
}

export interface RoomEngagementView {
  roomId: string;
  averageStayDurationSeconds: number;
  speakingToViewerRatio: number; // percentage (e.g. 25.5)
  giftIntensity: number; // gifts sent per participant
  coinIntensity: number; // coins spent per participant
}

export interface RevenueReportView {
  dateKey: string;
  roomId: string;
  userId: string;
  giftCoins: string; // BigInt to string
  creatorCoins: string; // BigInt to string
}

/** How many days of daily-series history to return, and optional room-type scope (AUDIO_ROOM vs VIDEO_ROOM). */
export class AnalyticsSeriesQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: ANALYTICS_DEFAULT_SERIES_DAYS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days: number = ANALYTICS_DEFAULT_SERIES_DAYS;

  @ApiPropertyOptional({
    enum: GiftContextType,
    description: 'Filter creator earnings specifically by room type (e.g. AUDIO_ROOM vs VIDEO_ROOM)',
  })
  @IsOptional()
  @IsEnum(GiftContextType)
  roomType?: GiftContextType;
}

export interface RoomDailyStatView {
  dateKey: string;
  joins: number;
  uniqueVisitors: number;
  peakParticipants: number;
  messages: number;
  giftCount: number;
  giftCoins: string;
  speakingSeconds: string;
  engagementScore: number;
}

export interface CreatorDailyStatView {
  dateKey: string;
  giftsReceivedCount: number;
  giftCoinsReceived: string;
  creatorEarnings: string;
  roomsHosted: number;
  speakingSeconds: string;
  engagementScore: number;
}

/** Live "today" snapshot of a room (from Redis counters). */
export interface RoomTodayView {
  dateKey: string;
  joins: number;
  uniqueVisitors: number;
  peakParticipants: number;
  messages: number;
  giftCount: number;
  giftCoins: number;
  speakingSeconds: number;
  engagementScore: number;
}

/** Full room-owner analytics report. */
export interface RoomReportView {
  roomId: string;
  activity: RoomActivityView | null;
  today: RoomTodayView;
  revenue: { giftCoins: string; creatorCoins: string };
  dailySeries: RoomDailyStatView[];
}

/** Live "today" snapshot of a creator. */
export interface CreatorTodayView {
  dateKey: string;
  giftsReceivedCount: number;
  giftCoinsReceived: number;
  creatorEarnings: number;
  roomsHosted: number;
  speakingSeconds: number;
  engagementScore: number;
}

/** Creator self-analytics report. */
export interface CreatorAnalyticsView {
  userId: string;
  today: CreatorTodayView;
  totals: {
    giftsReceivedCount: number;
    giftCoinsReceived: string;
    creatorEarnings: string;
    roomsHosted: number;
    speakingSeconds: string;
    audioHours: number;
  };
  revenue: { giftCoins: string; creatorCoins: string };
  dailySeries: CreatorDailyStatView[];
}
