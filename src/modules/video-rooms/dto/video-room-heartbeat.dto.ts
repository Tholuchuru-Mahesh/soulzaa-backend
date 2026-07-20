import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/**
 * Heartbeat request body (VR-3). Slides the session TTL and reports client
 * activity: `inBackground` drives the IDLE presence state; `networkQualityLevel`
 * is accepted for forward-compatibility (media/quality phases consume it later).
 */
export class VideoRoomHeartbeatDto {
  @ApiProperty({ description: 'The heartbeating /video-room socket id.' })
  @IsString()
  @Length(1, 64)
  socketId!: string;

  @ApiPropertyOptional({ description: 'True when the app is backgrounded (drives IDLE).' })
  @IsOptional()
  @IsBoolean()
  inBackground?: boolean;

  @ApiPropertyOptional({ description: 'Client-reported network quality 0 (worst) – 5 (best).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  networkQualityLevel?: number;
}
