import { ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomChatMode } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { VIDEO_ROOM_SLOW_MODE_MAX_SECONDS } from '../../constants/video-room.constants';

/**
 * VR-9.1a: patch the CHAT-scoped slice of a room's settings. Every field is
 * optional (a partial update) — omitted fields are left untouched. Seats,
 * media, economy and access settings are out of scope (`UpdateVideoRoomSettingsDto`
 * covers the full surface but has no consumer yet).
 *
 * `allowViewerChat` is deliberately NOT an accepted field here — it is a
 * deprecated column mirrored from `chatMode` by `VideoRoomChatSettingsService`,
 * never set directly by a caller.
 */
export class UpdateChatSettingsDto {
  @ApiPropertyOptional({ description: 'Master chat on/off switch for the room.' })
  @IsOptional()
  @IsBoolean()
  allowChat?: boolean;

  @ApiPropertyOptional({
    enum: VideoRoomChatMode,
    description:
      'NORMAL (everyone), PARTICIPANTS_ONLY (seated only), READ_ONLY (nobody), ANNOUNCEMENT_ONLY (mods only).',
  })
  @IsOptional()
  @IsEnum(VideoRoomChatMode)
  chatMode?: VideoRoomChatMode;

  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_SLOW_MODE_MAX_SECONDS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_SLOW_MODE_MAX_SECONDS)
  slowModeSeconds?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 4000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4000)
  chatMaxMessageLength?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  chatMaxAttachments?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  chatRateLimitPerMinute?: number;
}
