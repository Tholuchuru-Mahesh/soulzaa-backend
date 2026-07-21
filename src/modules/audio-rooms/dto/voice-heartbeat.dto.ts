import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { AUDIO_ROUTES } from '../constants/voice.constants';

/**
 * Periodic voice heartbeat carrying liveness + speaking + quality. High-
 * frequency and light: mostly Redis writes, DB quality sampled every Nth.
 */
export class VoiceHeartbeatDto {
  @ApiProperty({
    description: 'ZEGO network quality level 0 (best) – 4 (worst).',
    minimum: 0,
    maximum: 5,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  networkQualityLevel!: number;

  @ApiPropertyOptional({ description: 'Round-trip time (ms).', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60_000)
  rttMs?: number;

  @ApiPropertyOptional({ description: 'Packet loss percentage 0–100.', minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  packetLossPct?: number;

  @ApiPropertyOptional({ description: 'Current audio level 0–100 (drives speaker detection).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  audioLevel?: number;

  @ApiProperty({ description: 'Whether the client is currently speaking.' })
  @IsBoolean()
  isSpeaking!: boolean;

  @ApiPropertyOptional({ enum: AUDIO_ROUTES })
  @IsOptional()
  @IsIn(AUDIO_ROUTES)
  audioRoute?: string;

  @ApiPropertyOptional({ description: 'Whether the app is backgrounded.' })
  @IsOptional()
  @IsBoolean()
  inBackground?: boolean;
}
