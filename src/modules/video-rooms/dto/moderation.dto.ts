import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  VideoRoomBlockType,
  VideoRoomModerationMuteType,
  VideoRoomReportReason,
  VideoRoomReportStatus,
} from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { VIDEO_ROOM_MODERATION_DESCRIPTION_MAX } from '../constants/video-room-moderation.constants';
import { VIDEO_ROOM_MODERATION_REASON_MAX } from '../constants/video-room.constants';

/**
 * The two independently-mutable mute channels: text chat and mic/publish.
 * Omitting `channels` on a mute/unmute call means "both" (the pre-Phase-16
 * default), keeping every existing caller backward compatible.
 */
export type MuteChannel = 'chat' | 'mic';

const MUTE_CHANNELS: readonly MuteChannel[] = ['chat', 'mic'];

/**
 * Mute a member. TEMPORARY requires `durationMinutes`; PERMANENT lasts until
 * lifted. The additive optional `channels` (Phase 16) scopes the mute to chat
 * and/or mic; omitting it mutes every channel (unchanged pre-Phase-16
 * behaviour). There is no ban DTO — the Video Room has no ban feature; use
 * block to bar from the room.
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

  @ApiPropertyOptional({
    enum: MUTE_CHANNELS,
    isArray: true,
    description: 'Channels to mute; omit to mute both chat and mic.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MUTE_CHANNELS, { each: true })
  channels?: MuteChannel[];
}

/** Block a user from the room (durable blocklist; TEMPORARY or PERMANENT). */
export class BlockVideoRoomUserDto {
  @ApiProperty({ description: 'The user to block.' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ enum: VideoRoomBlockType, default: VideoRoomBlockType.PERMANENT })
  @IsOptional()
  @IsEnum(VideoRoomBlockType)
  type?: VideoRoomBlockType;

  @ApiPropertyOptional({ minimum: 1, description: 'Required for a TEMPORARY block.' })
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

/** Kick one or more members out of the room now (they may rejoin unless also blocked). */
export class KickVideoRoomUsersDto {
  @ApiProperty({ type: [String], description: 'The members to kick.' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  userIds!: string[];

  @ApiPropertyOptional({ maxLength: VIDEO_ROOM_MODERATION_REASON_MAX })
  @IsOptional()
  @IsString()
  @Length(0, VIDEO_ROOM_MODERATION_REASON_MAX)
  reason?: string;
}

/** Lift an active mute. Omitting `channels` unmutes every channel. */
export class UnmuteVideoRoomUserDto {
  @ApiProperty({ description: 'The member to unmute.' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({
    enum: MUTE_CHANNELS,
    isArray: true,
    description: 'Channels to unmute; omit to unmute both chat and mic.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MUTE_CHANNELS, { each: true })
  channels?: MuteChannel[];
}

/** Mute the whole room (all non-elevated members) on the given channel(s). */
export class MuteAllDto {
  @ApiPropertyOptional({
    enum: MUTE_CHANNELS,
    isArray: true,
    description: 'Channels to mute room-wide; omit to mute both chat and mic.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MUTE_CHANNELS, { each: true })
  channels?: MuteChannel[];
}

/** Reverse of `MuteAllDto`: lift a room-wide mute on the given channel(s). */
export class UnmuteAllDto {
  @ApiPropertyOptional({
    enum: MUTE_CHANNELS,
    isArray: true,
    description: 'Channels to unmute room-wide; omit to unmute both chat and mic.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MUTE_CHANNELS, { each: true })
  channels?: MuteChannel[];
}

/** Issue a warning to a user (no state change, audited + notified). */
export class WarnVideoRoomUserDto {
  @ApiProperty({ description: 'The member being warned.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ maxLength: VIDEO_ROOM_MODERATION_REASON_MAX })
  @IsString()
  @Length(1, VIDEO_ROOM_MODERATION_REASON_MAX)
  reason!: string;

  @ApiPropertyOptional({
    type: Object,
    description: 'Structured context for the warning (e.g. the offending message id).',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

/** Forcibly disconnect a member's realtime session without ending their membership. */
export class ForceDisconnectDto {
  @ApiProperty({ description: 'The member to force-disconnect.' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ maxLength: VIDEO_ROOM_MODERATION_REASON_MAX })
  @IsOptional()
  @IsString()
  @Length(0, VIDEO_ROOM_MODERATION_REASON_MAX)
  reason?: string;
}

/** Report another user (optionally about a specific message) in the room. */
export class ReportVideoRoomUserDto {
  @ApiProperty({ description: 'The user being reported.' })
  @IsUUID()
  targetUserId!: string;

  @ApiProperty({ enum: VideoRoomReportReason })
  @IsEnum(VideoRoomReportReason)
  reason!: VideoRoomReportReason;

  @ApiPropertyOptional({ maxLength: VIDEO_ROOM_MODERATION_DESCRIPTION_MAX })
  @IsOptional()
  @IsString()
  @Length(0, VIDEO_ROOM_MODERATION_DESCRIPTION_MAX)
  description?: string;

  @ApiPropertyOptional({ description: 'The offending chat message, if the report concerns one.' })
  @IsOptional()
  @IsUUID()
  messageId?: string;
}

/** Moderator resolution of a report. */
export class ReviewReportDto {
  @ApiProperty({
    enum: [
      VideoRoomReportStatus.REVIEWED,
      VideoRoomReportStatus.DISMISSED,
      VideoRoomReportStatus.ACTIONED,
    ],
  })
  @IsEnum(VideoRoomReportStatus)
  status!: VideoRoomReportStatus;

  @ApiPropertyOptional({ maxLength: VIDEO_ROOM_MODERATION_REASON_MAX })
  @IsOptional()
  @IsString()
  @Length(0, VIDEO_ROOM_MODERATION_REASON_MAX)
  resolutionAction?: string;

  @ApiPropertyOptional({ enum: ['WARNING', 'MUTE', 'KICK', 'BAN'] })
  @IsOptional()
  @IsString()
  @IsIn(['WARNING', 'MUTE', 'KICK', 'BAN'])
  recommendedAction?: 'WARNING' | 'MUTE' | 'KICK' | 'BAN';
}

/** Filters for paginated moderation listings (history, muted, blacklisted, warnings). */
export class ListModerationDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by the moderated/reported target user id.' })
  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @ApiPropertyOptional({ description: 'Filter by user id (e.g. for muted/warnings listings).' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
