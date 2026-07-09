import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Report the app entering/leaving background mode. */
export class VoiceBackgroundDto {
  @ApiProperty({ description: 'True when the app moved to background.' })
  @IsBoolean()
  inBackground!: boolean;
}
