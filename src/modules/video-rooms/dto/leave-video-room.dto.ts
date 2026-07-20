import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

/**
 * Leave-video-room request body (VR-3). `socketId` ends just that connection; when
 * omitted, every session the caller holds in the room is ended (full leave).
 */
export class LeaveVideoRoomDto {
  @ApiPropertyOptional({ description: "Socket to end; omit to end all the caller's sessions." })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  socketId?: string;
}
