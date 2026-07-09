import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** A dedicated voice-quality report (RTT / packet loss / jitter / level). */
export class VoiceQualityDto {
  @ApiProperty({ description: 'ZEGO quality level 0 (best) – 4 (worst).', minimum: 0, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  qualityLevel!: number;

  @ApiProperty({ description: 'Round-trip time (ms).', minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60_000)
  rttMs!: number;

  @ApiProperty({ description: 'Packet loss percentage 0–100.', minimum: 0, maximum: 100 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  packetLossPct!: number;

  @ApiPropertyOptional({ description: 'Jitter (ms).', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60_000)
  jitterMs?: number;
}
