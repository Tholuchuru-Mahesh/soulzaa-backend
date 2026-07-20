import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { VIDEO_ROOM_PASSWORD_SALT_ROUNDS } from '../constants/video-room.constants';

/**
 * Hash + verify video-room entry passwords (bcrypt via bcryptjs — the same $2
 * format the platform uses for account + audio-room passwords, no native build).
 * Own copy (not imported from audio-rooms) so the module boundary stays clean and
 * the room-password cost is tuned independently. VR-2 uses `hash` on create/lock;
 * `verify` is here for the join phase.
 */
@Injectable()
export class VideoRoomPasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, VIDEO_ROOM_PASSWORD_SALT_ROUNDS);
  }

  verify(plain: string, hashed: string): Promise<boolean> {
    return compare(plain, hashed);
  }
}
