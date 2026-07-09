import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { ROOM_PASSWORD_SALT_ROUNDS } from '../constants/audio-room.constants';

/**
 * Hash + verify audio-room entry passwords (bcrypt via bcryptjs — same $2
 * format as account passwords, no native build). Kept separate from the auth
 * PasswordService so room-password cost is tuned independently and the boundary
 * stays clean (this is the audio-rooms module's own concern).
 */
@Injectable()
export class RoomPasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, ROOM_PASSWORD_SALT_ROUNDS);
  }

  verify(plain: string, hashed: string): Promise<boolean> {
    return compare(plain, hashed);
  }
}
