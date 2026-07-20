import { Injectable } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { PlatformRole, VideoRoomMemberRole, VideoRoomSeatType } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import {
  VideoRoomPermission,
  videoRoomRoleHasPermission,
} from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';

/** The minimal room shape a permission decision needs. */
export interface PermissionRoomRef {
  id: string;
  ownerId: string;
}

/**
 * The single RBAC decision point for the video-room domain (VR-2). Resolves a
 * user's *effective* in-room role and checks it against the code
 * `VIDEO_ROOM_PERMISSION_MATRIX` — no hardcoded role checks scattered across the
 * lifecycle service. Platform ADMIN / SUPER_ADMIN bypass every room check.
 *
 * Effective-role precedence (VR-2 slice): OWNER (room.ownerId) → persisted grant
 * (`video_room_roles`, ADMIN / MODERATOR) → null. Seat-occupancy roles
 * (HOST / PARTICIPANT) and audience VIEWER carry no management permissions and are
 * resolved by the seat/join phases; VR-2 lifecycle authority is owner/grant only.
 */
@Injectable()
export class VideoRoomPermissionService {
  constructor(
    private readonly roles: VideoRoomRolesRepository,
    private readonly seats: VideoRoomSeatsRepository,
  ) {}

  /**
   * Effective-role precedence (VR-4): OWNER (room.ownerId) → persisted grant
   * (ADMIN / MODERATOR) → seat-derived (HOST on a HOST seat, PARTICIPANT on a GUEST
   * seat) → null. Seat-derived roles carry no management permissions (empty matrix
   * set) — they exist so role reporting + authority ranking are accurate.
   */
  async resolveEffectiveRole(
    room: PermissionRoomRef,
    userId: string,
  ): Promise<VideoRoomMemberRole | null> {
    if (room.ownerId === userId) return VideoRoomMemberRole.OWNER;
    const grant = await this.roles.find(room.id, userId);
    if (grant) return grant.role;
    const seat = await this.seats.findOccupiedSeat(room.id, userId);
    if (seat) {
      return seat.seatType === VideoRoomSeatType.GUEST
        ? VideoRoomMemberRole.PARTICIPANT
        : VideoRoomMemberRole.HOST;
    }
    return null;
  }

  /** True if `actor` may exercise `permission` in `room` (platform admin bypasses). */
  async hasPermission(
    actor: RoomActor,
    room: PermissionRoomRef,
    permission: VideoRoomPermission,
  ): Promise<boolean> {
    if (this.isPlatformAdmin(actor.roles)) return true;
    const role = await this.resolveEffectiveRole(room, actor.id);
    return role !== null && videoRoomRoleHasPermission(role, permission);
  }

  /** Throw VIDEO_ROOM_FORBIDDEN (403) unless `actor` holds `permission`. */
  async assertPermission(
    actor: RoomActor,
    room: PermissionRoomRef,
    permission: VideoRoomPermission,
  ): Promise<void> {
    if (!(await this.hasPermission(actor, room, permission))) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        `You do not have permission to ${permission} in this room.`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * The lifecycle-management gate: owner, platform admin, or an in-room ADMIN grant.
   * MODERATORs (content moderation only) and everyone else are rejected. Mirrors the
   * Audio Rooms `getManageableRoom` authority set. Specific irreversible powers
   * (close/delete via CLOSE_ROOM, transfer via TRANSFER_OWNERSHIP) still go through
   * `assertPermission`, which keeps them owner-only.
   */
  async assertCanManage(actor: RoomActor, room: PermissionRoomRef): Promise<void> {
    if (this.isPlatformAdmin(actor.roles)) return;
    const role = await this.resolveEffectiveRole(room, actor.id);
    if (role === VideoRoomMemberRole.OWNER || role === VideoRoomMemberRole.ADMIN) return;
    throw new BusinessException(
      ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      'Only the room owner or an admin may manage this room.',
      HttpStatus.FORBIDDEN,
    );
  }

  /** Numeric authority for role-hierarchy guards (higher outranks lower). */
  private static readonly RANK: Record<VideoRoomMemberRole, number> = {
    [VideoRoomMemberRole.OWNER]: 5,
    [VideoRoomMemberRole.ADMIN]: 4,
    [VideoRoomMemberRole.MODERATOR]: 3,
    [VideoRoomMemberRole.HOST]: 2,
    [VideoRoomMemberRole.PARTICIPANT]: 1,
    [VideoRoomMemberRole.VIEWER]: 0,
  };

  /** The user's authority rank in the room (0 if they hold no role). */
  async authorityRank(room: PermissionRoomRef, userId: string): Promise<number> {
    const role = await this.resolveEffectiveRole(room, userId);
    return role ? VideoRoomPermissionService.RANK[role] : 0;
  }

  /**
   * Guard for moderation over another user (force-transfer / remove / kick): the
   * actor must strictly outrank the target. Throws VIDEO_ROOM_FORBIDDEN otherwise.
   */
  async assertOutranks(room: PermissionRoomRef, actorId: string, targetId: string): Promise<void> {
    const [actorRank, targetRank] = await Promise.all([
      this.authorityRank(room, actorId),
      this.authorityRank(room, targetId),
    ]);
    if (actorRank <= targetRank) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        'You cannot act on a user of equal or higher authority.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private isPlatformAdmin(platformRoles: PlatformRole[]): boolean {
    return (
      platformRoles.includes(PlatformRole.ADMIN) || platformRoles.includes(PlatformRole.SUPER_ADMIN)
    );
  }
}
