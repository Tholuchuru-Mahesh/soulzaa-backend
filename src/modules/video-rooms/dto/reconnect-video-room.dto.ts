import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

/**
 * Reconnect-video-room request body (VR-3). `socketId` is the caller's NEW socket
 * after a network blip; `previousSocketId` carries the reconnect count forward;
 * `lastVersion` lets the client detect how stale its room state was.
 */
export class ReconnectVideoRoomDto {
  @ApiProperty({ description: "The caller's new /video-room Socket.IO socket id." })
  @IsString()
  @Length(1, 64)
  socketId!: string;

  @ApiPropertyOptional({
    description: 'The socket id that dropped (carries reconnectCount forward).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  previousSocketId?: string;

  @ApiPropertyOptional({ description: 'Registered device UUID.' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Client platform, e.g. IOS / ANDROID / WEB.' })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  platform?: string;

  @ApiPropertyOptional({ description: 'The room state version the client last held.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  lastVersion?: number;
}
