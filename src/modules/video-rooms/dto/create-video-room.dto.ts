import { ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomVisibility } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { VideoRoomAccessPolicy } from '../constants/video-room-lifecycle';
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
      'Declared access policy (PASSWORD / INVITE_ONLY / FOLLOWERS_ONLY / FRIENDS_ONLY / VIP_ONLY). ' +
      'Stored now; join-gate enforcement lands with the join phase. PASSWORD requires a password.',
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

  @IsVideoRoomMaxParticipants()
  maxParticipants?: number;

  @IsVideoRoomMaxViewers()
  maxViewers?: number;
}
