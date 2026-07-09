import { ApiPropertyOptional } from '@nestjs/swagger';
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
  ValidateIf,
} from 'class-validator';
import {
  ROOM_DESCRIPTION_MAX,
  ROOM_MIN_PARTICIPANTS,
  ROOM_NAME_MAX,
  ROOM_NAME_MIN,
  ROOM_PASSWORD_MAX,
  ROOM_PASSWORD_MIN,
} from '../constants/audio-room.constants';

/**
 * Editable room fields. Every field is optional (partial update). To clear a
 * category/language/image/password send `null`; omit to leave unchanged.
 */
export class UpdateRoomDto {
  @ApiPropertyOptional({ minLength: ROOM_NAME_MIN, maxLength: ROOM_NAME_MAX })
  @IsOptional()
  @IsString()
  @Length(ROOM_NAME_MIN, ROOM_NAME_MAX)
  name?: string;

  @ApiPropertyOptional({ maxLength: ROOM_DESCRIPTION_MAX, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(ROOM_DESCRIPTION_MAX)
  description?: string | null;

  @ApiPropertyOptional({ description: 'S3 object key of the room display picture', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(512)
  imageKey?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ example: 'en', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(2, 8)
  language?: string | null;

  @ApiPropertyOptional({ enum: RoomVisibility })
  @IsOptional()
  @IsEnum(RoomVisibility)
  visibility?: RoomVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  @ApiPropertyOptional({
    description: 'Set a new entry password, or null to remove password protection.',
    minLength: ROOM_PASSWORD_MIN,
    maxLength: ROOM_PASSWORD_MAX,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(ROOM_PASSWORD_MIN, ROOM_PASSWORD_MAX)
  password?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDiscoverable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(ROOM_MIN_PARTICIPANTS)
  @Max(100_000)
  maxParticipants?: number;
}
