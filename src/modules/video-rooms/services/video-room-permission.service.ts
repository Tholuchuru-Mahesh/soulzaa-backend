import { HttpStatus, Injectable } from '@nestjs/common';
import { PlatformRole, VideoRoomMemberRole, VideoRoomSeatType } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import {
  VIDEO_ROOM_ROLE_RANK,
  VideoRoomPermission,
  videoRoomRolePermissions,
} from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import {
  VideoRoomPermissionCache,
  type PermissionDecision,
} from './video-room-permission-cache.service';

/** The minimal room shape a permission decision needs. */
export interface PermissionRoomRef {
  id: string;
  ownerId: string;
}

/** A fully resolved authorization answer for one user in one room. */
export interface VideoRoomCapabilities {
  role: VideoRoomMemberRole | null;
  permissions: VideoRoomPermission[];
  temporary: boolean;
  isPlatformAdmin: boolean;
}

/**
 * The single RBAC decision point for the video-room domain. Resolves a user's
 * *effective* in-room role and checks it against the code
 * `VIDEO_ROOM_PERMISSION_MATRIX` — no hardcoded role checks scattered across the
 * lifecycle, seat, media or viewer services. Platform ADMIN / SUPER_ADMIN bypass
 * every room check.
 *
 * Effective-role precedence: OWNER (room.ownerId) → active persisted grant
 * (`video_room_roles`, expiry-aware) → seat-derived (HOST on a HOST seat,
 * PARTICIPANT on a GUEST seat) → null. Seat-derived roles carry no management
 * permissions; they exist so role reporting and authority ranking are accurate.
 *
 * VR-7 changed two things. Every resolution now flows through the versioned
 * `VideoRoomPermissionCache`, so a check is one Redis round trip on the hot path
 * and a database read only on a miss. And `assertCanManage` is gone: room
 * management is the `MANAGE_ROOM` permission, because a coarse `OWNER || ADMIN`
 * gate sitting beside the fine matrix always won where the two overlapped, which
 * is how the PRD's admin restrictions went unenforced for six phases.
 */
@Injectable()
export class VideoRoomPermissionService {
  constructor(
    private readonly roles: VideoRoomRolesRepository,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly cache: VideoRoomPermissionCache,
    private readonly metrics: VideoRoomsMetrics,
  ) {}

  /** The user's effective role, cache-first. */
  async resolveEffectiveRole(
    room: PermissionRoomRef,
    userId: string,
  ): Promise<VideoRoomMemberRole | null> {
    return (await this.resolve(room, userId)).role;
  }

  /** Full capability set for a user — backs GET /:id/me/permissions. */
  async resolveCapabilities(
    actor: RoomActor,
    room: PermissionRoomRef,
  ): Promise<VideoRoomCapabilities> {
    const isPlatformAdmin = this.isPlatformAdmin(actor.roles);
    const resolved = await this.resolve(room, actor.id);
    return {
      role: resolved.role,
      // Staff bypass every room check, so reporting their in-room permission set
      // would understate what they can actually do.
      permissions: isPlatformAdmin ? Object.values(VideoRoomPermission) : resolved.permissions,
      temporary: resolved.temporary,
      isPlatformAdmin,
    };
  }

  /**
   * True if `actor` may exercise `permission` in `room` (platform admin bypasses).
   * This is the instrumented entry point — the latency histogram and the
   * allowed/denied counters are recorded here rather than in `resolve`, so a
   * measurement reflects one *decision*, not one cache lookup.
   */
  async hasPermission(
    actor: RoomActor,
    room: PermissionRoomRef,
    permission: VideoRoomPermission,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const allowed = this.isPlatformAdmin(actor.roles)
      ? true
      : (await this.resolve(room, actor.id)).permissions.includes(permission);

    this.metrics.observeAuthorization((Date.now() - startedAt) / 1000);
    this.metrics.incPermissionCheck(allowed ? 'allowed' : 'denied');
    if (!allowed) this.metrics.incPermissionDenial(permission);
    return allowed;
  }

  /** True if `actor` holds at least one of `permissions`. */
  async hasAnyPermission(
    actor: RoomActor,
    room: PermissionRoomRef,
    permissions: VideoRoomPermission[],
  ): Promise<boolean> {
    if (this.isPlatformAdmin(actor.roles)) return true;
    const held = (await this.resolve(room, actor.id)).permissions;
    return permissions.some((permission) => held.includes(permission));
  }

  /** True if `actor` holds every one of `permissions`. */
  async hasAllPermissions(
    actor: RoomActor,
    room: PermissionRoomRef,
    permissions: VideoRoomPermission[],
  ): Promise<boolean> {
    if (this.isPlatformAdmin(actor.roles)) return true;
    const held = (await this.resolve(room, actor.id)).permissions;
    return permissions.every((permission) => held.includes(permission));
  }

  /** True if `actor`'s effective in-room role is exactly `role`. */
  async hasRole(
    actor: RoomActor,
    room: PermissionRoomRef,
    role: VideoRoomMemberRole,
  ): Promise<boolean> {
    return (await this.resolve(room, actor.id)).role === role;
  }

  /**
   * True when the user's elevated grant carries an expiry, so a client can render
   * "Temporary Admin". Reports the *grant's* nature, not whether it is still
   * valid — an expired grant has already resolved away to no role at all.
   */
  async hasTemporaryRole(room: PermissionRoomRef, userId: string): Promise<boolean> {
    return (await this.resolve(room, userId)).temporary;
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

  /** The user's authority rank in the room (0 if they hold no role). */
  async authorityRank(room: PermissionRoomRef, userId: string): Promise<number> {
    const { role } = await this.resolve(room, userId);
    return role ? VIDEO_ROOM_ROLE_RANK[role] : 0;
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

  /**
   * Cache-first resolution — the one place role derivation happens, so every
   * predicate above shares a single decision and a single cache entry.
   */
  private async resolve(room: PermissionRoomRef, userId: string): Promise<PermissionDecision> {
    const cached = await this.cache.read(room.id, userId);
    if (cached) {
      return { role: cached.role, permissions: cached.permissions, temporary: cached.temporary };
    }
    const fresh = await this.derive(room, userId);
    await this.cache.write(room.id, userId, fresh);
    return fresh;
  }

  /** Owner → active grant → seat occupancy → nothing. */
  private async derive(room: PermissionRoomRef, userId: string): Promise<PermissionDecision> {
    if (room.ownerId === userId) {
      return this.decision(VideoRoomMemberRole.OWNER, false);
    }
    const grant = await this.roles.findActive(room.id, userId);
    if (grant) {
      return this.decision(grant.role, grant.expiresAt !== null);
    }
    const seat = await this.seats.findOccupiedSeat(room.id, userId);
    if (seat) {
      const role =
        seat.seatType === VideoRoomSeatType.GUEST
          ? VideoRoomMemberRole.PARTICIPANT
          : VideoRoomMemberRole.HOST;
      return this.decision(role, false);
    }
    return this.decision(VideoRoomMemberRole.VIEWER, false);
  }

  private decision(role: VideoRoomMemberRole, temporary: boolean): PermissionDecision {
    return { role, permissions: videoRoomRolePermissions(role), temporary };
  }

  private isPlatformAdmin(platformRoles: PlatformRole[]): boolean {
    return (
      platformRoles.includes(PlatformRole.ADMIN) || platformRoles.includes(PlatformRole.SUPER_ADMIN)
    );
  }
}
