import { ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomVisibility } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { VideoRoomAccessPolicy } from '../constants/video-room-lifecycle';
import { VIDEO_ROOM_MAX_SEATS } from '../constants/video-room.constants';
import {
  IsVideoRoomCategory,
  IsVideoRoomDescription,
  IsVideoRoomLanguage,
  IsVideoRoomMaxParticipants,
  IsVideoRoomMaxViewers,
  IsVideoRoomName,
  IsVideoRoomPassword,
} from '../validators/video-room.validators';

/**
 * Create-video-room request body. Fully validated + documented for Swagger.
 * NOTE (VR-0): the create endpoint returns 501 — this DTO defines the contract
 * the lifecycle phase will implement against.
 */
export class CreateVideoRoomDto {
  @IsVideoRoomName()
  name!: string;

  @IsVideoRoomDescription()
  description?: string;

  @ApiPropertyOptional({ description: 'S3 object key of the room cover image.' })
  @IsOptional()
  @IsString()
  imageKey?: string;

  @IsVideoRoomCategory()
  categoryId?: string;

  @IsVideoRoomLanguage()
  language?: string;

  @ApiPropertyOptional({ enum: VideoRoomVisibility, default: VideoRoomVisibility.PUBLIC })
  @IsOptional()
  @IsEnum(VideoRoomVisibility)
  visibility?: VideoRoomVisibility;

  @ApiPropertyOptional({
    enum: VideoRoomAccessPolicy,
    description:
      'Declared access policy (INVITE_ONLY / FOLLOWERS_ONLY / FRIENDS_ONLY / VIP_ONLY). ' +
      'Stored now; join-gate enforcement lands with the join phase.',
  })
  @IsOptional()
  @IsEnum(VideoRoomAccessPolicy)
  accessPolicy?: VideoRoomAccessPolicy;

  @IsVideoRoomPassword()
  password?: string;

  @ApiPropertyOptional({ description: 'Free-form discovery tags (all must match on search).' })
  @IsOptional()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'ISO country code for nearby discovery.' })
  @IsOptional()
  @IsString()
  @Length(2, 8)
  country?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isDiscoverable?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: VIDEO_ROOM_MAX_SEATS - 1,
    description:
      'Speaking seats besides the owner. Total stage = 1 + hostSeatCount + guestSeatCount. ' +
      'Omitted ⇒ the platform default. This is the STAGE size, which is not the same thing ' +
      'as maxParticipants (how many people may be in the room at all).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_MAX_SEATS - 1)
  hostSeatCount?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: VIDEO_ROOM_MAX_SEATS - 1, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIDEO_ROOM_MAX_SEATS - 1)
  guestSeatCount?: number;

  @IsVideoRoomMaxParticipants()
  maxParticipants?: number;

  @IsVideoRoomMaxViewers()
  maxViewers?: number;

  @ApiPropertyOptional({ default: false, description: 'Whether paid entry is required to join.' })
  @IsOptional()
  @IsBoolean()
  paidEntryEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000000, description: 'Entry fee in Gold Coins when paid entry is enabled.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  entryFee?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000000, description: 'Alias for entryFee.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  defaultEntryFee?: number;
}
