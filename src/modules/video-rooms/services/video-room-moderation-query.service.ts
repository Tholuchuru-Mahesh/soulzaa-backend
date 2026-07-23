import { HttpStatus, Injectable } from '@nestjs/common';
import type { VideoRoomBlock, VideoRoomMute, VideoRoomWarning } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { ListModerationDto } from '../dto/moderation.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import {
  VideoRoomModerationRepository,
  type AppendModerationActionInput,
} from '../repositories/video-room-moderation.repository';
import { VideoRoomWarningRepository } from '../repositories/video-room-warning.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import {
  VideoRoomPermissionService,
  type PermissionRoomRef,
} from './video-room-permission.service';

/** One row of the audit history read (`GET .../moderation/history`). */
export type VideoRoomModerationActionView = AppendModerationActionInput & {
  id: string;
  createdAt: Date;
};

/**
 * Any one of these grants elevated read access to a room's moderation
 * records — the same three permissions the Audio Room blueprint gates its
 * kick/mute/ban listings behind, ORed together because a moderator with only
 * `MUTE_USERS` (say) still has a legitimate reason to see who else is muted,
 * blocked, or warned in the room they moderate.
 */
const ELEVATED_MODERATION_READ_PERMISSIONS: VideoRoomPermission[] = [
  VideoRoomPermission.KICK_USERS,
  VideoRoomPermission.BLOCK_USERS,
  VideoRoomPermission.MUTE_USERS,
];

/**
 * The CQRS read side for VR-16 (Task 17): paginated moderation listings —
 * the append-only action history, the room's current mute/blacklist rosters,
 * and issued warnings. Reads only — never mutates, never enqueues, never
 * touches the Redis enforcement mirrors — so it can be called freely from a
 * controller with no lifecycle side effects. Mirrors the VR-12
 * `VideoRoomPkQueryService` / VR-11 `VideoRoomTreasureQueryService`
 * conventions: one room lookup + one permission gate per call, then a single
 * repository round trip through `buildPaginated`.
 *
 * Every method here is gated on the same elevated-read check
 * (`hasAnyPermission([KICK_USERS, BLOCK_USERS, MUTE_USERS])`) rather than a
 * single fixed permission, because these are read-only compliance/roster
 * views: any moderator capability is sufficient to see them, unlike the
 * stronger single-permission gates the corresponding *write* actions use in
 * `VideoRoomModerationService`.
 */
@Injectable()
export class VideoRoomModerationQueryService {
  constructor(
    private readonly moderationRepo: VideoRoomModerationRepository,
    private readonly warningRepo: VideoRoomWarningRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
  ) {}

  /** The room's moderation audit trail, newest first, optionally scoped to `targetUserId`. */
  async history(
    actor: RoomActor,
    roomId: string,
    query: ListModerationDto,
  ): Promise<Paginated<VideoRoomModerationActionView>> {
    const ref = await this.requireElevatedRead(actor, roomId);
    const [rows, total] = await this.moderationRepo.listActions(
      ref.id,
      query.skip,
      query.limit,
      query.targetUserId,
    );
    return buildPaginated(rows as VideoRoomModerationActionView[], total, query.page, query.limit);
  }

  /** The room's current mute roster, newest first, optionally scoped to `userId`. */
  async mutedUsers(
    actor: RoomActor,
    roomId: string,
    query: ListModerationDto,
  ): Promise<Paginated<VideoRoomMute>> {
    const ref = await this.requireElevatedRead(actor, roomId);
    const [rows, total] = await this.moderationRepo.listActiveMutes(
      ref.id,
      query.skip,
      query.limit,
      query.userId,
    );
    return buildPaginated(rows, total, query.page, query.limit);
  }

  /** The room's blacklist (active blocks), newest first, optionally scoped to `userId`. */
  async blacklistedUsers(
    actor: RoomActor,
    roomId: string,
    query: ListModerationDto,
  ): Promise<Paginated<VideoRoomBlock>> {
    const ref = await this.requireElevatedRead(actor, roomId);
    const [rows, total] = await this.moderationRepo.listActiveBlocks(
      ref.id,
      query.skip,
      query.limit,
      query.userId,
    );
    return buildPaginated(rows, total, query.page, query.limit);
  }

  /** Warnings issued in the room, newest first, optionally scoped to `userId`. */
  async warnings(
    actor: RoomActor,
    roomId: string,
    query: ListModerationDto,
  ): Promise<Paginated<VideoRoomWarning>> {
    const ref = await this.requireElevatedRead(actor, roomId);
    const [rows, total] = await this.warningRepo.list(ref.id, {
      skip: query.skip,
      take: query.limit,
      userId: query.userId,
    });
    return buildPaginated(rows, total, query.page, query.limit);
  }

  /**
   * The room lookup (404 if missing) + elevated-read permission gate (403
   * otherwise) shared by every method above. Room-not-found is checked
   * before the permission check: with no room there is nothing to authorize
   * against, and a 404 is a more accurate answer than a 403.
   */
  private async requireElevatedRead(actor: RoomActor, roomId: string): Promise<PermissionRoomRef> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    const ref: PermissionRoomRef = { id: room.id, ownerId: room.ownerId };
    const allowed = await this.permissions.hasAnyPermission(
      actor,
      ref,
      ELEVATED_MODERATION_READ_PERMISSIONS,
    );
    if (!allowed) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'You do not have permission to view moderation records in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    return ref;
  }
}
