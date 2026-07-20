import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  VIDEO_ROOM_MAX_SEATS,
  VIDEO_ROOM_SLOW_MODE_MAX_SECONDS,
} from '../constants/video-room.constants';

/**
 * Patch a room's configurable settings. Every field is optional (a partial
 * update). NOTE (VR-1): the endpoint returns 501 until the settings phase; this
 * DTO defines the full configurable surface (mirrors VideoRoomSettings).
 */
export class UpdateVideoRoomSettingsDto {
  // ---- Chat ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowChat?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowViewerChat?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_SLOW_MODE_MAX_SECONDS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_SLOW_MODE_MAX_SECONDS)
  slowModeSeconds?: number;

  // ---- Economy / interactive ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowGifts?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowTreasure?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowPk?: boolean;

  // ---- Media ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowBeauty?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowCameraSwitch?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowScreenShare?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowRecording?: boolean;

  // ---- Access / social ----
  @ApiPropertyOptional() @IsOptional() @IsBoolean() joinApprovalRequired?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowJoinRequest?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowShare?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowInvite?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowFollow?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowReporting?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowAnnouncements?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isRoomMuted?: boolean;

  // ---- Limits ----
  @ApiPropertyOptional({ minimum: 1, description: 'Max session length; omit for unlimited.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxDurationMinutes?: number;

  // ---- Seat layout ----
  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_MAX_SEATS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_MAX_SEATS)
  hostSeatCount?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_MAX_SEATS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_MAX_SEATS)
  guestSeatCount?: number;
}
