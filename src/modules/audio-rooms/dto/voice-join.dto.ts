import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AUDIO_ROUTES } from '../constants/voice.constants';

/** Payload to join the voice channel. Device/route are optional client hints. */
export class VoiceJoinDto {
  @ApiPropertyOptional({ description: 'Client device identifier (for logs).' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;

  @ApiPropertyOptional({ enum: AUDIO_ROUTES, description: 'Initial audio output route.' })
  @IsOptional()
  @IsIn(AUDIO_ROUTES)
  audioRoute?: string;
}
