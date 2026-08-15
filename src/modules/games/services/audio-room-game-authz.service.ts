import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { RoomMemberRole } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';

const MANAGER_ROLES: ReadonlySet<RoomMemberRole> = new Set([
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
]);

/**
 * Authorization seam between the Audio Rooms module and games/casino — makes
 * room membership/ownership the real boundary for who may start, join, or
 * watch a game tied to a room. Modeled directly on
 * `RoomUtilAuthz` (`src/modules/room-utilities/services/room-util-authz.service.ts`),
 * the existing sanctioned pattern for "a room-scoped feature gated by
 * audio-room membership/host status" (polls/dice/spin-wheel). Depends only on
 * the public `IAudioRoomsService` contract — never reaches into the
 * audio-rooms module's internals.
 *
 * Every check here is server-side and re-run at the point of action (lobby
 * create, session start, socket join) — a client's "Start Game"/"Watch Game"
 * buttons are a UX convenience only, never the actual gate.
 */
@Injectable()
export class AudioRoomGameAuthzService {
  constructor(@Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService) {}

  /**
   * Board games (Ludo/Carrom): OWNER/ADMIN/PREMIUM_ADMIN authority + the room
   * must be live. Same bar as `RoomUtilAuthz.assertHostAction`.
   */
  async assertCanStartBoardGame(roomId: string, userId: string): Promise<void> {
    const role = await this.rooms.getEffectiveRole(roomId, userId);
    if (!role || !MANAGER_ROLES.has(role)) {
      throw new BusinessException(
        ERROR_CODES.GAME_NOT_AUTHORIZED,
        'Only the room owner or an admin can start a game here.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!(await this.rooms.isRoomLive(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Casino windows (Lucky Fruit/Greedy Food): deliberately tighter than board
   * games — exact room-owner authority only, not ADMIN/PREMIUM_ADMIN, since
   * this gates who may place real GOLD-coin bets through the room's embed.
   */
  async assertCanStartCasinoWindow(roomId: string, userId: string): Promise<void> {
    const ownerId = await this.rooms.getOwnerId(roomId);
    if (!ownerId || ownerId !== userId) {
      throw new BusinessException(
        ERROR_CODES.GAME_NOT_AUTHORIZED,
        'Only the room owner can start this game here.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!(await this.rooms.isRoomLive(roomId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Active room membership (any role) — the bar for watching/spectating. Throws NOT_ROOM_MEMBER otherwise. */
  async assertCanWatch(roomId: string, userId: string): Promise<void> {
    await this.rooms.assertMember(roomId, userId);
  }

  /** Non-throwing membership check for hot paths (e.g. the socket join-policy lookup). */
  isMember(roomId: string, userId: string): Promise<boolean> {
    return this.rooms.isMember(roomId, userId);
  }
}
