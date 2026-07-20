import { IsVideoRoomPassword } from '../validators/video-room.validators';

/**
 * Lock-room request body (VR-2). An optional password sets/changes the room's
 * entry password while locking; omitting it locks a room that already has a
 * password (or locks without a password gate). Unlock takes no body.
 */
export class LockVideoRoomDto {
  @IsVideoRoomPassword()
  password?: string;
}
