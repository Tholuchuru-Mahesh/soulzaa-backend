import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { RoomMemberRole } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';

const MANAGER_ROLES: ReadonlySet<RoomMemberRole> = new Set([
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
]);

/**
 * Shared authorization + liveness checks for the room-utility services. Host
 * tools (create poll / roll dice / spin / start countdown …) require room
 * owner/admin authority and a live room; participation (voting) only requires
 * active membership. Every create-action re-checks here server-side, so the
 * client's host-tools panel is a UX convenience only.
 */
@Injectable()
export class RoomUtilAuthz {
  constructor(@Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService) {}

  /** Owner/admin authority + the room must be live. Throws otherwise. */
  async assertHostAction(roomId: string, actor: RoomActor): Promise<void> {
    const role = await this.rooms.getEffectiveRole(roomId, actor.id);
    if (!role || !MANAGER_ROLES.has(role)) {
      throw new BusinessException(
        ERROR_CODES.ROOM_UTIL_NOT_AUTHORIZED,
        'Only the room owner or an admin can use this tool.',
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

  /** Active membership (any role). Throws NOT_ROOM_MEMBER otherwise. */
  async assertMember(roomId: string, userId: string): Promise<void> {
    await this.rooms.assertMember(roomId, userId);
  }

  /** Live stage snapshot for the random picker's candidate resolution. */
  rooms$(): IAudioRoomsService {
    return this.rooms;
  }
}
