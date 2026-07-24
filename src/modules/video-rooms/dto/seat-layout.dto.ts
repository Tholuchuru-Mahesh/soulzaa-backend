import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { VIDEO_ROOM_MAX_SEATS } from '../constants/video-room.constants';

/**
 * VR-17 — reshape the stage. Total seats are `1 + host + guest` (index 0 is the
 * owner), so the service rejects anything above VIDEO_ROOM_MAX_SEATS. The client
 * maps a layout choice N ∈ {4,6,8,9,12} to `hostSeatCount = N - 1`.
 */
export class ConfigureSeatLayoutDto {
  @ApiProperty({ minimum: 0, maximum: VIDEO_ROOM_MAX_SEATS })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_MAX_SEATS)
  hostSeatCount!: number;

  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_MAX_SEATS, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_MAX_SEATS)
  guestSeatCount?: number;
}
