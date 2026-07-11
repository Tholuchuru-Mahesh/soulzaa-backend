import { HttpStatus, Injectable } from '@nestjs/common';
import { PlatformRole, RoomMemberRole } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { ROOM_PERMISSION_MATRIX, RoomPermission } from '../constants/room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';

/**
 * Resolves a user's *effective* in-room role and enforces the room permission
 * matrix. Effective role precedence: an authoritative `room_roles` grant
 * (OWNER/ADMIN/PREMIUM_ADMIN) → else SPEAKER when the user occupies a speaker/
 * premium seat → else LISTENER when an active member → else null. Platform
 * ADMIN/SUPER_ADMIN bypass every in-room check.
 */
@Injectable()
export class RoomPermissionService {
  constructor(
    private readonly rooms: AudioRoomsRepository,
    private readonly seats: AudioRoomSeatsRepository,
  ) {}

  isPlatformAdmin(roles: PlatformRole[]): boolean {
    return roles.includes(PlatformRole.ADMIN) || roles.includes(PlatformRole.SUPER_ADMIN);
  }

  /**
   * Platform staff who may moderate ANY room (PRD §8 Moderator Module): a
   * MODERATOR plus ADMIN/SUPER_ADMIN. Distinct from `isPlatformAdmin` — a
   * moderator can kick/ban/mute but does not get the full admin bypass (e.g.
   * they still cannot outrank a room owner unless they are also admin).
   */
  isPlatformModerator(roles: PlatformRole[]): boolean {
    return this.isPlatformAdmin(roles) || roles.includes(PlatformRole.MODERATOR);
  }

  /**
   * The user's effective in-room role, or null if not an active member. A user
   * must be present in the room to hold any role, so membership is checked first
   * — a stale grant on someone who has left resolves to null.
   */
  async getEffectiveRole(roomId: string, userId: string): Promise<RoomMemberRole | null> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) return null;

    const grant = await this.seats.getRole(roomId, userId);
    if (grant) return grant.role;

    const seat = await this.seats.getSeatByOccupant(roomId, userId);
    if (seat) return RoomMemberRole.SPEAKER;

    return RoomMemberRole.LISTENER;
  }

  /** True when the actor (platform admin OR effective role) holds the permission. */
  async hasPermission(roomId: string, actor: RoomActor, perm: RoomPermission): Promise<boolean> {
    if (this.isPlatformAdmin(actor.roles)) return true;
    const role = await this.getEffectiveRole(roomId, actor.id);
    if (!role) return false;
    return ROOM_PERMISSION_MATRIX[role]?.has(perm) ?? false;
  }

  /** Throws FORBIDDEN/NOT_ROOM_ADMIN when the actor lacks the permission. */
  async assertPermission(roomId: string, actor: RoomActor, perm: RoomPermission): Promise<void> {
    if (!(await this.hasPermission(roomId, actor, perm))) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_ADMIN,
        `You do not have permission to perform this action (${perm}).`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * True when the user currently occupies any stage seat, has temporary speaking
   * permission, or holds an elevated role grant (OWNER / ADMIN / PREMIUM_ADMIN).
   * Owners and admins always have PUBLISHER voice rights even without a seat so
   * that the room owner can speak from the moment they start the room.
   */
  async isSpeaker(roomId: string, userId: string): Promise<boolean> {
    const isSeated = (await this.seats.getSeatByOccupant(roomId, userId)) !== null;
    if (isSeated) return true;

    // Elevated role holders (owner/admin) always have publish rights.
    const grant = await this.seats.getRole(roomId, userId);
    if (
      grant &&
      (grant.role === RoomMemberRole.OWNER ||
        grant.role === RoomMemberRole.ADMIN ||
        grant.role === RoomMemberRole.PREMIUM_ADMIN)
    ) {
      return true;
    }

    const member = await this.rooms.getMember(roomId, userId);
    return member?.tempSpeakAllowed === true;
  }

  /**
   * Whether a user (by id, no platform-role bypass) holds a permission via their
   * effective in-room role. Used by other modules through the public contract.
   */
  async userHasPermission(roomId: string, userId: string, perm: RoomPermission): Promise<boolean> {
    const role = await this.getEffectiveRole(roomId, userId);
    if (!role) return false;
    return ROOM_PERMISSION_MATRIX[role]?.has(perm) ?? false;
  }

  // ======================= Moderation (AR-3) =======================

  /** True when the actor may perform moderation in this room. */
  async canModerate(roomId: string, actor: RoomActor): Promise<boolean> {
    if (this.isPlatformModerator(actor.roles)) return true;
    return this.hasPermission(roomId, actor, RoomPermission.MODERATE_USERS);
  }

  /** Throws when the actor may not moderate this room. */
  async assertCanModerate(roomId: string, actor: RoomActor): Promise<void> {
    if (!(await this.canModerate(roomId, actor))) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_ADMIN,
        'You do not have permission to moderate this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Authority rank of a user's effective in-room role (higher = stronger):
   * OWNER 4, ADMIN/PREMIUM_ADMIN 3, SPEAKER 2, LISTENER 1, non-member 0.
   */
  async authorityRank(roomId: string, userId: string): Promise<number> {
    const role = await this.getEffectiveRole(roomId, userId);
    switch (role) {
      case RoomMemberRole.OWNER:
        return 4;
      case RoomMemberRole.ADMIN:
      case RoomMemberRole.PREMIUM_ADMIN:
        return 3;
      case RoomMemberRole.SPEAKER:
        return 2;
      case RoomMemberRole.LISTENER:
      case RoomMemberRole.AUDIENCE:
        return 1;
      default:
        return 0;
    }
  }

  /**
   * Role-hierarchy guard: the actor must outrank the target. Platform
   * ADMIN/SUPER_ADMIN always outrank everyone (including the owner). A platform
   * MODERATOR outranks everyone EXCEPT the room owner (only admin/super-admin
   * may act on an owner). In-room actors must strictly outrank the target by
   * effective role. Throws INSUFFICIENT_AUTHORITY / CANNOT_MODERATE_OWNER.
   */
  async assertOutranks(roomId: string, actor: RoomActor, targetUserId: string): Promise<void> {
    if (this.isPlatformAdmin(actor.roles)) return;

    const targetRank = await this.authorityRank(roomId, targetUserId);
    const targetIsOwner = targetRank === 4;

    if (this.isPlatformModerator(actor.roles)) {
      if (targetIsOwner) {
        throw new BusinessException(
          ERROR_CODES.CANNOT_MODERATE_OWNER,
          'Only a platform admin can moderate a room owner.',
          HttpStatus.FORBIDDEN,
        );
      }
      return;
    }

    const actorRank = await this.authorityRank(roomId, actor.id);
    if (targetIsOwner) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_MODERATE_OWNER,
        'The room owner cannot be moderated.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (actorRank <= targetRank) {
      throw new BusinessException(
        ERROR_CODES.INSUFFICIENT_AUTHORITY,
        'You cannot moderate a user of equal or higher authority.',
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
