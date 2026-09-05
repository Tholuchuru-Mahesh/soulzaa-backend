import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import {
  VIDEO_ROOM_DESCRIPTION_MAX,
  VIDEO_ROOM_MIN_PARTICIPANTS,
  VIDEO_ROOM_MIN_VIEWERS,
  VIDEO_ROOM_NAME_MAX,
  VIDEO_ROOM_NAME_MIN,
} from '../constants/video-room.constants';

/**
 * Reusable, composed field validators for video-room DTOs. Each bundles the
 * class-validator rules with the matching Swagger metadata so the bound, the
 * validation, and the API docs cannot drift apart — bounds come from the single
 * source in constants/video-room.constants.ts. Import these into DTOs instead of
 * re-declaring `@IsString() @Length(...)` per field.
 */

export function IsVideoRoomName(): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ minLength: VIDEO_ROOM_NAME_MIN, maxLength: VIDEO_ROOM_NAME_MAX }),
    IsString(),
    Length(VIDEO_ROOM_NAME_MIN, VIDEO_ROOM_NAME_MAX),
  );
}

export function IsVideoRoomDescription(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({ maxLength: VIDEO_ROOM_DESCRIPTION_MAX }),
    IsOptional(),
    IsString(),
    Length(0, VIDEO_ROOM_DESCRIPTION_MAX),
  );
}

export function IsVideoRoomCategory(): PropertyDecorator {
  return applyDecorators(ApiPropertyOptional(), IsOptional(), IsString());
}

export function IsVideoRoomLanguage(): PropertyDecorator {
  return applyDecorators(ApiPropertyOptional(), IsOptional(), IsString(), Length(2, 10));
}

export function IsVideoRoomMaxParticipants(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({ minimum: VIDEO_ROOM_MIN_PARTICIPANTS }),
    IsOptional(),
    Type(() => Number),
    IsInt(),
    Min(VIDEO_ROOM_MIN_PARTICIPANTS),
  );
}

export function IsVideoRoomMaxViewers(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({ minimum: VIDEO_ROOM_MIN_VIEWERS }),
    IsOptional(),
    Type(() => Number),
    IsInt(),
    Min(VIDEO_ROOM_MIN_VIEWERS),
  );
}
