import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  PlatformRole,
  Prisma,
  VideoRoomLogAction,
  VideoRoomMemberRole,
  VideoRoomModerationActionType,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { ErrorCode } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VIDEO_ROOM_MAX_ADMINS } from '../constants/video-room.constants';
import type { GrantVideoRoomRoleDto } from '../dto/grant-video-room-role.dto';
import type {
  RemoveVideoRoomRoleDto,
  UpdateVideoRoomRoleDto,
  VideoRoomRoleResponseDto,
} from '../dto/video-room-role.dto';
import {
  RoleAssignedEvent,
  RoleRemovedEvent,
  RoleUpdatedEvent,
  TemporaryRoleGrantedEvent,
} from '../events/video-room-role.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionCache } from './video-room-permission-cache.service';
import {
  VideoRoomPermissionService,
  type PermissionRoomRef,
} from './video-room-permission.service';

/**
 * Role assignment engine (VR-7). Every mutation runs the same ordered validation
 * chain before any write, so privilege escalation is refused in one place rather
 * than re-argued per endpoint. Writes then follow a fixed order — persist,
 * mirror, audit, invalidate, publish — with the cache bump *after* the write, so
 * no concurrent reader can repopulate an entry describing the old authority.
 *
 * The PRD (production.txt:3341-3372) is the policy this encodes: only the room
 * owner appoints admins, and a room holds at most 25 of them.
 */
@Injectable()
export class VideoRoomRoleService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly roles: VideoRoomRolesRepository,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly cache: VideoRoomPermissionCache,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /** Every active elevated grant in the room. Requires room membership. */
  async listRoles(actor: RoomActor, roomId: string): Promise<VideoRoomRoleResponseDto[]> {
    const room = await this.requireRoom(roomId);
    await this.requireActiveMember(room.id, actor.id, 'You must be a member of this room.');
    const grants = await this.roles.listActiveByRoom(room.id);
    return grants.map((grant) => this.toResponse(grant));
  }

  /** Grant an elevated role. Runs the full validation chain. */
  async assign(
    actor: RoomActor,
    roomId: string,
    dto: GrantVideoRoomRoleDto,
  ): Promise<VideoRoomRoleResponseDto> {
    const room = await this.requireRoom(roomId);
    await this.validate(actor, room, dto.userId, dto.role);

    const existing = await this.roles.findActive(room.id, dto.userId);
    if (existing?.role === dto.role) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_DUPLICATE_ROLE,
        'That user already holds this role.',
        HttpStatus.CONFLICT,
      );
    }
    await this.assertRoleCapacity(room.id, dto.role);

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const granted = await this.write(room.id, actor.id, dto.userId, dto.role, expiresAt);

    await this.bus.publish(
      new RoleAssignedEvent({
        roomId: room.id,
        userId: dto.userId,
        actorId: actor.id,
        role: dto.role,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      }),
    );
    if (expiresAt) {
      await this.bus.publish(
        new TemporaryRoleGrantedEvent({
          roomId: room.id,
          userId: dto.userId,
          actorId: actor.id,
          role: dto.role,
          expiresAt: expiresAt.toISOString(),
        }),
      );
    }
    return granted;
  }

  /** Replace an existing grant with a different role and/or expiry. */
  async update(
    actor: RoomActor,
    roomId: string,
    dto: UpdateVideoRoomRoleDto,
  ): Promise<VideoRoomRoleResponseDto> {
    const room = await this.requireRoom(roomId);
    await this.validate(actor, room, dto.userId, dto.role);

    const existing = await this.roles.findActive(room.id, dto.userId);
    if (!existing) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND,
        'That user has no elevated role to update.',
        HttpStatus.NOT_FOUND,
      );
    }
    // Only a role *change* can push the room over a cap; an expiry-only edit
    // leaves the counts exactly as they were.
    if (existing.role !== dto.role) await this.assertRoleCapacity(room.id, dto.role);

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const updated = await this.write(room.id, actor.id, dto.userId, dto.role, expiresAt);

    await this.bus.publish(
      new RoleUpdatedEvent({
        roomId: room.id,
        userId: dto.userId,
        actorId: actor.id,
        previousRole: existing.role,
        role: dto.role,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      }),
    );
    return updated;
  }

  /** Revoke a grant, returning the user to plain membership. */
  async remove(actor: RoomActor, roomId: string, dto: RemoveVideoRoomRoleDto): Promise<void> {
    const room = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.GRANT_ROLES);

    const existing = await this.roles.findActive(room.id, dto.userId);
    if (!existing) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND,
        'That user has no elevated role.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (existing.role === VideoRoomMemberRole.OWNER) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_INVALID,
        'The owner role cannot be revoked — transfer ownership instead.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.assertNoEscalation(room, actor, dto.userId);

    await this.roles.revoke(room.id, dto.userId);
    await this.rooms.setMemberRole(room.id, dto.userId, VideoRoomMemberRole.VIEWER, actor.id);
    await this.audit(room.id, actor.id, dto.userId, VideoRoomModerationActionType.ROLE_REVOKED, {
      role: existing.role,
    });
    await this.cache.invalidateRoom(room.id);
    await this.bus.publish(
      new RoleRemovedEvent({
        roomId: room.id,
        userId: dto.userId,
        actorId: actor.id,
        role: existing.role,
      }),
    );
  }

  // ======================= validation chain =======================

  /** The shared pre-write chain for assign and update. */
  private async validate(
    actor: RoomActor,
    room: PermissionRoomRef,
    targetId: string,
    role: VideoRoomMemberRole,
  ): Promise<void> {
    await this.permissions.assertPermission(actor, room, VideoRoomPermission.GRANT_ROLES);

    if (targetId === actor.id) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY,
        'You cannot change your own role.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (role === VideoRoomMemberRole.OWNER) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_INVALID,
        'Ownership is transferred, not assigned.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.requireActiveMember(
      room.id,
      targetId,
      'The user must be an active member of the room.',
    );
    await this.assertNoEscalation(room, actor, targetId);
  }

  /**
   * The anti-escalation policy: may `actor` change `targetId`'s role at all?
   *
   * Three rules, applied in this order:
   *
   *  1. **Platform staff bypass.** ADMIN / SUPER_ADMIN are exempt from in-room
   *     hierarchy entirely, so support can perform recovery and emergency
   *     moderation in rooms where they hold no in-room role (rank 0) and would
   *     otherwise be unable to act on anyone.
   *  2. **The room owner is never a target.** Checked against `room.ownerId`
   *     directly rather than by rank, so it holds even if ranks are ever
   *     rebalanced. Ownership moves only through the dedicated transfer workflow
   *     (`VideoRoomOwnershipService`), never as a side effect of a role edit.
   *  3. **Strict outranking.** `actorRank > targetRank`. Equality is refused, so
   *     two admins can never demote each other — peer-on-peer moderation is the
   *     standard griefing vector in room products, and forbidding it costs
   *     nothing because the owner can always resolve a dispute.
   *
   * Rule 1 precedes rule 2 deliberately: staff acting on an owner is exactly the
   * account-recovery case the bypass exists for.
   *
   * @param room     the room the action targets
   * @param actor    who is acting
   * @param targetId whose role is being changed
   * @throws BusinessException(VIDEO_ROOM_CANNOT_MODERATE_OWNER, 403) targeting the owner
   * @throws BusinessException(VIDEO_ROOM_INVALID_HIERARCHY, 403) when outranked or equal
   */
  private async assertNoEscalation(
    room: PermissionRoomRef,
    actor: RoomActor,
    targetId: string,
  ): Promise<void> {
    if (this.isPlatformStaff(actor)) return;

    if (targetId === room.ownerId) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER,
        'The room owner cannot be moderated — use the ownership transfer flow instead.',
        HttpStatus.FORBIDDEN,
      );
    }

    const [actorRank, targetRank] = await Promise.all([
      this.permissions.authorityRank(room, actor.id),
      this.permissions.authorityRank(room, targetId),
    ]);
    if (actorRank <= targetRank) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY,
        'You cannot change the role of a user with equal or higher authority.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Platform staff exempt from in-room hierarchy (support / recovery tooling). */
  private isPlatformStaff(actor: RoomActor): boolean {
    return (
      actor.roles.includes(PlatformRole.ADMIN) || actor.roles.includes(PlatformRole.SUPER_ADMIN)
    );
  }

  /** PRD: at most 25 admins per room. Other roles are uncapped. */
  private async assertRoleCapacity(roomId: string, role: VideoRoomMemberRole): Promise<void> {
    if (role !== VideoRoomMemberRole.ADMIN) return;
    const count = await this.roles.countByRole(roomId, VideoRoomMemberRole.ADMIN);
    if (count >= VIDEO_ROOM_MAX_ADMINS) {
      throw this.fail(
        ERROR_CODES.VIDEO_ROOM_ROLE_LIMIT_EXCEEDED,
        `A room may have at most ${VIDEO_ROOM_MAX_ADMINS} admins.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  // ======================= write path =======================

  /**
   * Persist → mirror → audit → invalidate, in that order. The member-row `role`
   * is a denormalised mirror for roster rendering; `video_room_roles` remains the
   * authority, so the mirror is written second and never read for a decision.
   */
  private async write(
    roomId: string,
    actorId: string,
    userId: string,
    role: VideoRoomMemberRole,
    expiresAt: Date | null,
  ): Promise<VideoRoomRoleResponseDto> {
    const grant = await this.roles.grant({ roomId, userId, role, grantedBy: actorId, expiresAt });
    await this.rooms.setMemberRole(roomId, userId, role, actorId);
    await this.audit(roomId, actorId, userId, VideoRoomModerationActionType.ROLE_GRANTED, {
      role,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
    await this.cache.invalidateRoom(roomId);
    return this.toResponse(grant);
  }

  /** Both audit trails: the room log and the moderation-action record. */
  private async audit(
    roomId: string,
    actorId: string,
    targetUserId: string,
    action: VideoRoomModerationActionType,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.rooms.appendLog({
      roomId,
      actorId,
      action: VideoRoomLogAction.ROLE_CHANGED,
      metadata: { targetUserId, ...metadata },
    });
    await this.moderation.appendAction({
      roomId,
      moderatorId: actorId,
      targetUserId,
      action,
      metadata,
    });
  }

  // ======================= helpers =======================

  private toResponse(grant: {
    userId: string;
    role: VideoRoomMemberRole;
    grantedBy: string | null;
    expiresAt: Date | null;
  }): VideoRoomRoleResponseDto {
    return {
      userId: grant.userId,
      role: grant.role,
      grantedBy: grant.grantedBy,
      expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      temporary: grant.expiresAt !== null,
    };
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

  private async requireActiveMember(
    roomId: string,
    userId: string,
    message: string,
  ): Promise<void> {
    const member = await this.rooms.getMember(roomId, userId);
    if (!member?.isActive) {
      throw this.fail(ERROR_CODES.VIDEO_ROOM_NOT_MEMBER, message, HttpStatus.BAD_REQUEST);
    }
  }

  private fail(code: ErrorCode, message: string, status: HttpStatus): BusinessException {
    return new BusinessException(code, message, status);
  }
}
