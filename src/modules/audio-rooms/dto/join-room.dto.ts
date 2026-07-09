import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { ROOM_PASSWORD_MAX, ROOM_PASSWORD_MIN } from '../constants/audio-room.constants';

/** Optional password supplied when joining a locked, password-protected room. */
export class JoinRoomDto {
  @ApiPropertyOptional({ minLength: ROOM_PASSWORD_MIN, maxLength: ROOM_PASSWORD_MAX })
  @IsOptional()
  @IsString()
  @Length(ROOM_PASSWORD_MIN, ROOM_PASSWORD_MAX)
  password?: string;
}
