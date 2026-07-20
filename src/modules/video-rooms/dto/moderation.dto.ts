import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomModerationMuteType } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { VIDEO_ROOM_MODERATION_REASON_MAX } from '../constants/video-room.constants';

/**
 * Mute a member. TEMPORARY requires `durationMinutes`; PERMANENT lasts until
 * lifted. NOTE (VR-1): endpoints return 501 until the moderation phase. There is
 * no ban DTO — the Video Room has no ban feature; use block to bar from the room.
 */
export class MuteVideoRoomUserDto {
  @ApiProperty({ description: 'The member to mute.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: VideoRoomModerationMuteType })
  @IsEnum(VideoRoomModerationMuteType)
  type!: VideoRoomModerationMuteType;

  @ApiPropertyOptional({ minimum: 1, description: 'Required for a TEMPORARY mute.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @ApiPropertyOptional({ maxLength: VIDEO_ROOM_MODERATION_REASON_MAX })
  @IsOptional()
  @IsString()
  @Length(0, VIDEO_ROOM_MODERATION_REASON_MAX)
  reason?: string;
}

/** Block a user from the room (durable blocklist; lasts until lifted). */
export class BlockVideoRoomUserDto {
  @ApiProperty({ description: 'The user to block.' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ maxLength: VIDEO_ROOM_MODERATION_REASON_MAX })
  @IsOptional()
  @IsString()
  @Length(0, VIDEO_ROOM_MODERATION_REASON_MAX)
  reason?: string;
}
