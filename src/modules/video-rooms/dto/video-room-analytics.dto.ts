import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { VideoRoomAnalyticsPeriod } from '../enums/video-room-analytics.enum';

export class QueryAnalyticsDto {
  @ApiPropertyOptional({
    enum: VideoRoomAnalyticsPeriod,
    default: VideoRoomAnalyticsPeriod.TODAY,
    description: 'Time period for analytics filtering',
  })
  @IsOptional()
  @IsEnum(VideoRoomAnalyticsPeriod)
  period?: VideoRoomAnalyticsPeriod = VideoRoomAnalyticsPeriod.TODAY;

  @ApiPropertyOptional({ description: 'Start date ISO string for CUSTOM period' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date ISO string for CUSTOM period' })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Target room UUID filter' })
  @IsOptional()
  @IsUUID('4')
  roomId?: string;

  @ApiPropertyOptional({ description: 'Target host UUID filter' })
  @IsOptional()
  @IsUUID('4')
  hostId?: string;

  @ApiPropertyOptional({ description: 'Target viewer UUID filter' })
  @IsOptional()
  @IsUUID('4')
  viewerId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class RoomAnalyticsDto {
  @ApiProperty({ description: 'Room ID' })
  roomId!: string;

  @ApiProperty({ description: 'Peak viewer count' })
  peakViewers!: number;

  @ApiProperty({ description: 'Peak participant count' })
  peakParticipants!: number;

  @ApiProperty({ description: 'Average concurrent users' })
  averageConcurrentUsers!: number;

  @ApiProperty({ description: 'Average session duration in seconds' })
  averageSessionDuration!: number;

  @ApiProperty({ description: 'Total active time in seconds' })
  activeTimeSeconds!: number;

  @ApiProperty({ description: 'Total room duration in seconds' })
  totalDurationSeconds!: number;

  @ApiProperty({ description: 'Total room creation count or status' })
  roomStatus!: string;
}

export class HostAnalyticsDto {
  @ApiProperty({ description: 'Host user ID' })
  hostId!: string;

  @ApiProperty({ description: 'Number of rooms hosted' })
  roomsHosted!: number;

  @ApiProperty({ description: 'Average room duration in seconds' })
  averageRoomDuration!: number;

  @ApiProperty({ description: 'Average viewer count across hosted rooms' })
  averageViewers!: number;

  @ApiProperty({ description: 'Peak viewers across hosted rooms' })
  peakViewers!: number;

  @ApiProperty({ description: 'Total gifts received by host' })
  hostGiftsReceived!: number;

  @ApiProperty({ description: 'Total earnings in gold coins' })
  hostEarnings!: number;

  @ApiProperty({ description: 'Total PK battle wins' })
  pkWins!: number;

  @ApiProperty({ description: 'Total treasure events completed' })
  treasureEvents!: number;
}

export class ViewerAnalyticsDto {
  @ApiProperty({ description: 'Viewer user ID' })
  viewerId!: string;

  @ApiProperty({ description: 'Total viewer sessions' })
  viewerSessions!: number;

  @ApiProperty({ description: 'Total watch time in seconds' })
  watchTimeSeconds!: number;

  @ApiProperty({ description: 'Total rejoin count' })
  rejoinCount!: number;

  @ApiPropertyOptional({ description: 'First join timestamp' })
  firstJoinedAt?: string;

  @ApiPropertyOptional({ description: 'Last left timestamp' })
  lastLeftAt?: string;
}

export class GiftAnalyticsDto {
  @ApiProperty({ description: 'Total gifts sent count' })
  giftCount!: number;

  @ApiProperty({ description: 'Total gift revenue in coins' })
  giftRevenue!: number;

  @ApiProperty({ description: 'Luxury gifts count' })
  luxuryGiftsCount!: number;

  @ApiProperty({ description: 'Average gift value in coins' })
  averageGiftValue!: number;

  @ApiProperty({ description: 'Top gifters array', type: [Object] })
  topGifters!: Array<{ userId: string; amount: number }>;

  @ApiProperty({ description: 'Top receivers array', type: [Object] })
  topReceivers!: Array<{ userId: string; amount: number }>;

  @ApiProperty({ description: 'Gift types distribution map', type: Object })
  giftTypesDistribution!: Record<string, number>;
}

export class PKAnalyticsDto {
  @ApiProperty({ description: 'Battles started count' })
  battlesStarted!: number;

  @ApiProperty({ description: 'Battles completed count' })
  battlesCompleted!: number;

  @ApiProperty({ description: 'Win rate (0.0 - 1.0)' })
  winRate!: number;

  @ApiProperty({ description: 'Average PK duration in seconds' })
  averagePkDuration!: number;

  @ApiProperty({ description: 'Average score achieved' })
  averageScore!: number;

  @ApiProperty({ description: 'Total gift contribution during PK battles' })
  giftContribution!: number;
}

export class TreasureAnalyticsDto {
  @ApiProperty({ description: 'Boxes created count' })
  boxesCreated!: number;

  @ApiProperty({ description: 'Total treasure unlocks count' })
  treasureUnlocks!: number;

  @ApiProperty({ description: 'Total reward pool coins distributed' })
  rewardPool!: number;

  @ApiProperty({ description: 'Average completion time in seconds' })
  averageCompletionTime!: number;
}

export class AnalyticsResponseDto<T = unknown> {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ description: 'Response payload data' })
  data!: T;

  @ApiPropertyOptional({ description: 'Optional metadata / period / dateKey' })
  metadata?: Record<string, unknown>;
}
