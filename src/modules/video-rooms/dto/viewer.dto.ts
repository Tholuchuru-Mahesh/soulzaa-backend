import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

/**
 * Viewer-mode request bodies (VR-6). Join/leave/reconnect/heartbeat are
 * field-for-field identical to the VR-3 member DTOs, so they're re-exported
 * under viewer names below rather than re-declared (DRY). Promote/demote are
 * new — host-driven seat orchestration over an existing viewer.
 */
export class PromoteViewerDto {
  @ApiProperty({ format: 'uuid', description: 'The viewer to seat.' })
  @IsUUID()
  targetUserId!: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Target seat; omit to auto-pick an open seat.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  seatIndex?: number;
}

export class DemoteViewerDto {
  @ApiProperty({ format: 'uuid', description: 'The participant to return to the audience.' })
  @IsUUID()
  targetUserId!: string;
}

// JoinViewerDto / LeaveViewerDto / ReconnectViewerDto / ViewerHeartbeatDto:
// re-export the existing Join/Leave/Reconnect/Heartbeat DTOs (identical fields).
export { JoinVideoRoomDto as JoinViewerDto } from './join-video-room.dto';
export { LeaveVideoRoomDto as LeaveViewerDto } from './leave-video-room.dto';
export { ReconnectVideoRoomDto as ReconnectViewerDto } from './reconnect-video-room.dto';
export { VideoRoomHeartbeatDto as ViewerHeartbeatDto } from './video-room-heartbeat.dto';
