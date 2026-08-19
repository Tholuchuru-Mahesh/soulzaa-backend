// src/modules/platform-moderation/dto/ban-user-globally.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Ban a user from every room type (audio room, video room, live stream) for 24 hours. */
export class BanUserGloballyDto {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
