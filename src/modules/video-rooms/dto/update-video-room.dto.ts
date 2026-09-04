import { PartialType } from '@nestjs/swagger';
import { CreateVideoRoomDto } from './create-video-room.dto';

/**
 * Update-video-room request body: every create field made optional.
 * NOTE (VR-0): the update endpoint returns 501 — this defines the
 * contract for the lifecycle phase.
 */
export class UpdateVideoRoomDto extends PartialType(CreateVideoRoomDto) {}
