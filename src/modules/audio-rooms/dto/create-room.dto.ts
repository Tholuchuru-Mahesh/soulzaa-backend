import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoomVisibility } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ROOM_DESCRIPTION_MAX,
  ROOM_MIN_PARTICIPANTS,
  ROOM_NAME_MAX,
  ROOM_NAME_MIN,
  ROOM_PASSWORD_MAX,
  ROOM_PASSWORD_MIN,
} from '../constants/audio-room.constants';

/** Payload to create an audio room (PRD Vol.2 §13 — name, picture, category,
 * language, description, lock/password, visibility, capacity). */
export class CreateRoomDto {
  @ApiProperty({
    example: 'Late Night Music Lounge',
    minLength: ROOM_NAME_MIN,
    maxLength: ROOM_NAME_MAX,
  })
  @IsString()
  @Length(ROOM_NAME_MIN, ROOM_NAME_MAX)
  name!: string;

  @ApiPropertyOptional({
    example: 'Chill beats and good vibes ✨',
    maxLength: ROOM_DESCRIPTION_MAX,
  })
  @IsOptional()
  @IsString()
  @MaxLength(ROOM_DESCRIPTION_MAX)
  description?: string;

  @ApiPropertyOptional({ description: 'S3 object key of the room display picture' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageKey?: string;

  @ApiPropertyOptional({ description: 'Room category id (see GET /rooms/categories)' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    example: 'en',
    description: 'ISO 639-1 language code (see GET /rooms/languages)',
  })
  @IsOptional()
  @IsString()
  @Length(2, 8)
  language?: string;

  @ApiPropertyOptional({ enum: RoomVisibility, default: RoomVisibility.PUBLIC })
  @IsOptional()
  @IsEnum(RoomVisibility)
  visibility?: RoomVisibility;

  @ApiPropertyOptional({ default: false, description: 'Lock the room (restrict entry).' })
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  @ApiPropertyOptional({
    description: 'Optional entry password. When set the room is password-protected.',
    minLength: ROOM_PASSWORD_MIN,
    maxLength: ROOM_PASSWORD_MAX,
  })
  @IsOptional()
  @IsString()
  @Length(ROOM_PASSWORD_MIN, ROOM_PASSWORD_MAX)
  password?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Show the room in discovery/trending listings.',
  })
  @IsOptional()
  @IsBoolean()
  isDiscoverable?: boolean;

  @ApiPropertyOptional({
    description: 'Max concurrent participants (clamped to the platform cap).',
  })
  @IsOptional()
  @IsInt()
  @Min(ROOM_MIN_PARTICIPANTS)
  @Max(100_000)
  maxParticipants?: number;
}
