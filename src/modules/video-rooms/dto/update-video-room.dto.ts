import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateVideoRoomDto } from './create-video-room.dto';

/**
 * Update-video-room request body: every create field made optional, plus the
 * lock toggle. NOTE (VR-0): the update endpoint returns 501 — this defines the
 * contract for the lifecycle phase.
 */
export class UpdateVideoRoomDto extends PartialType(CreateVideoRoomDto) {
  @ApiPropertyOptional({ description: 'Lock/unlock the room (password required while locked).' })
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;
}
