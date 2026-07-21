import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { VideoRoomLogAction, VideoRoomMemberRole } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { ErrorCode } from 'src/common/exceptions/error-codes';
import { LockService } from 'src/infra/redis/lock.service';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { TransferVideoRoomOwnershipDto } from '../dto/video-room-role.dto';
import { OwnershipTransferredEvent } from '../events/video-room-role.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomLifecycleService } from './video-room-lifecycle.service';
import { VideoRoomPermissionCache } from './video-room-permission-cache.service';
import {
  VideoRoomPermissionService,
  type PermissionRoomRef,
} from './video-room-permission.service';

/** Largest page of members scanned when looking for a successor. */
const RECOVERY_MEMBER_SCAN = 200;

/**
 * Room ownership (VR-7). Exactly one owner exists at any moment — structurally,
 * because `VideoRoom.ownerId` is a single column and `resolveEffectiveRole`
 * consults it before any grant, so there is no way to represent two owners.
 *
 * Both paths run under one per-room lock. Transfer is a multi-step swap (demote,
 * revoke, reassign) and two concurrent transfers interleaving could leave the
 * previous owner demoted with the room handed to neither target; recovery shares
 * the lock so it cannot race a transfer either.
 *
 * History is the existing append-only `video_room_logs` — `OWNERSHIP_TRANSFERRED`
 * has been in that enum since VR-1, unused until now. No dedicated history table,
 * and deliberately no reclaim window: reclaim would let ownership change without
 * the sitting owner's consent.
 */
@Injectable()
export class VideoRoomOwnershipService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly roles: VideoRoomRolesRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly cache: VideoRoomPermissionCache,
    private readonly locks: LockService,
    private readonly lifecycle: VideoRoomLifecycleService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Hand the room to another active member. Owner-only (TRANSFER_OWNERSHIP). */
  async transfer(
    actor: RoomActor,
    roomId: string,
    dto: TransferVideoRoomOwnershipDto,
  ): Promise<void> {
    const room = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.TRANSFER_OWNERSHIP);

    if (dto.newOwnerId === room.ownerId) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED,
        'That user is already the room owner.',
        HttpStatus.CONFLICT,
      );
    }

    const member = await this.rooms.getMember(room.id, dto.newOwnerId);
    if (!member?.isActive) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
        'The new owner must be an active member of the room.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.locks.withLock(this.lockKey(room.id), async () => {
      await this.handOver(room.id, room.ownerId, dto.newOwnerId, actor.id, {
        demotePrevious: true,
      });
    });

    await this.announce(room.id, room.ownerId, dto.newOwnerId, actor.id, 'TRANSFER');
  }

  /**
   * "Owner Recovery": promote the highest-ranking remaining active member when
   * the owner is gone, closing the room if nobody is left.
   *
   * Deliberately has NO automatic trigger. An owner leaving a room is normal and
   * reversible — they reconnect constantly — so auto-succession on `leave` would
   * hand rooms away from owners who never left in any meaningful sense. It is
   * invoked explicitly by platform staff, or by a later moderation/reaping phase.
   *
   * Unlike a transfer, the departed owner receives no ADMIN grant: succession is
   * not a handover, and the previous owner is by definition not around to use it.
   */
  async recoverOwner(actor: RoomActor, roomId: string): Promise<{ newOwnerId: string | null }> {
    const room = await this.requireRoom(roomId);

    const successor = await this.locks.withLock(this.lockKey(room.id), async () => {
      const candidate = await this.findSuccessor(room);
      if (!candidate) return null;
      await this.handOver(room.id, room.ownerId, candidate, actor.id, { demotePrevious: false });
      return candidate;
    });

    if (!successor) {
      await this.lifecycle.close(actor, room.id);
      return { newOwnerId: null };
    }

    await this.announce(room.id, room.ownerId, successor, actor.id, 'RECOVERY');
    return { newOwnerId: successor };
  }

  /** The highest-ranking active member other than the departed owner. */
  private async findSuccessor(room: PermissionRoomRef): Promise<string | null> {
    const members = await this.rooms.listActiveMembers(room.id, RECOVERY_MEMBER_SCAN, 0);
    const candidates = members.filter((member) => member.userId !== room.ownerId);

    let successor: string | null = null;
    let best = -1;
    for (const candidate of candidates) {
      const rank = await this.permissions.authorityRank(room, candidate.userId);
      if (rank > best) {
        best = rank;
        successor = candidate.userId;
      }
    }
    return successor;
  }

  /**
   * The ownership swap itself. The new owner's elevated grant is revoked because
   * ownership lives in `room.ownerId`, not in a grant row — leaving both would
   * give them two independent sources of authority and make a later revocation
   * ambiguous about what it actually removed.
   */
  private async handOver(
    roomId: string,
    previousOwnerId: string,
    newOwnerId: string,
    actorId: string,
    opts: { demotePrevious: boolean },
  ): Promise<void> {
    if (opts.demotePrevious) {
      await this.roles.grant({
        roomId,
        userId: previousOwnerId,
        role: VideoRoomMemberRole.ADMIN,
        grantedBy: actorId,
        expiresAt: null,
      });
      await this.rooms.setMemberRole(roomId, previousOwnerId, VideoRoomMemberRole.ADMIN, actorId);
    }
    await this.roles.revoke(roomId, newOwnerId);
    await this.rooms.setOwner(roomId, newOwnerId, actorId);
    await this.rooms.setMemberRole(roomId, newOwnerId, VideoRoomMemberRole.OWNER, actorId);
  }

  /** Audit + cache bump + event, shared by transfer and recovery. */
  private async announce(
    roomId: string,
    previousOwnerId: string,
    newOwnerId: string,
    actorId: string,
    reason: 'TRANSFER' | 'RECOVERY',
  ): Promise<void> {
    await this.rooms.appendLog({
      roomId,
      actorId,
      action: VideoRoomLogAction.OWNERSHIP_TRANSFERRED,
      metadata: { previousOwnerId, newOwnerId, reason },
    });
    await this.cache.invalidateRoom(roomId);
    await this.bus.publish(
      new OwnershipTransferredEvent({ roomId, previousOwnerId, newOwnerId, actorId, reason }),
    );
  }

  /** Transfer and recovery share one lock so they can never race each other. */
  private lockKey(roomId: string): string {
    return `video-room:transfer:{${roomId}}`;
  }

  private async requireRoom(roomId: string): Promise<PermissionRoomRef> {
    // findById already excludes soft-deleted rooms.
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return { id: room.id, ownerId: room.ownerId };
  }

  private fail(code: ErrorCode, message: string, status: HttpStatus): BusinessException {
    return new BusinessException(code, message, status);
  }
}
