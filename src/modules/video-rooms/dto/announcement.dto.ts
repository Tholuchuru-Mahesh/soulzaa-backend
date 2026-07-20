import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { VIDEO_ROOM_ANNOUNCEMENT_MAX } from '../constants/video-room.constants';

/**
 * Post a room announcement. NOTE (VR-1): endpoints return 501 until the
 * announcements phase; these DTOs define the contracts.
 */
export class CreateVideoRoomAnnouncementDto {
  @ApiProperty({ minLength: 1, maxLength: VIDEO_ROOM_ANNOUNCEMENT_MAX })
  @IsString()
  @Length(1, VIDEO_ROOM_ANNOUNCEMENT_MAX)
  content!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}

/** Edit an existing announcement (content and/or pin state). */
export class UpdateVideoRoomAnnouncementDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: VIDEO_ROOM_ANNOUNCEMENT_MAX })
  @IsOptional()
  @IsString()
  @Length(1, VIDEO_ROOM_ANNOUNCEMENT_MAX)
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}
