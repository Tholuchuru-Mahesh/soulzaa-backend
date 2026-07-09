import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { AUDIO_ROUTES } from '../constants/voice.constants';

/** Report an audio output route switch (speaker/earpiece/bluetooth/wired). */
export class VoiceRouteDto {
  @ApiProperty({ enum: AUDIO_ROUTES })
  @IsIn(AUDIO_ROUTES)
  route!: string;
}
