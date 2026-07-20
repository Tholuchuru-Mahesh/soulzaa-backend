import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import {
  VIDEO_ROOM_PASSWORD_MAX,
  VIDEO_ROOM_PASSWORD_MIN,
} from '../constants/video-room.constants';

/**
 * Join-video-room request body (VR-3). `socketId` binds the membership to the
 * caller's live `/video-room` socket; `deviceId` keys per-device duplicate-session
 * eviction; `password` is required only for a locked room (non-owner, first join).
 */
export class JoinVideoRoomDto {
  @ApiProperty({ description: "The caller's /video-room Socket.IO socket id." })
  @IsString()
  @Length(1, 64)
  socketId!: string;

  @ApiPropertyOptional({ description: 'Registered device UUID (per-device session key).' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Client platform, e.g. IOS / ANDROID / WEB.' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  platform?: string;

  @ApiPropertyOptional({ description: 'Room password (required for a locked room).' })
  @IsOptional()
  @IsString()
  @Length(VIDEO_ROOM_PASSWORD_MIN, VIDEO_ROOM_PASSWORD_MAX)
  password?: string;
}
