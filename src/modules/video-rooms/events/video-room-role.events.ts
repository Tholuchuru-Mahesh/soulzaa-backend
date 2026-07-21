import { VideoRoomMemberRole } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Video-room role & ownership domain events on the EVENT_BUS (VR-7). The module's
 * own `VideoRoomRoleSocketListener` bridges these to `video_room.role_*` /
 * `video_room.ownership_transferred` broadcasts; downstream domains (analytics,
 * notifications, moderation) may subscribe without importing this module.
 *
 * Kept in its own registry rather than added to `VIDEO_ROOM_EVENTS`, matching
 * VR-4 seats and VR-5 media: that constant is owned by `VideoRoomSocketListener`,
 * whose spec asserts it relays every name in it, so a phase that appends there
 * without extending that listener silently breaks the contract.
 *
 * There is deliberately no `PermissionGranted` / `PermissionRevoked` pair. In a
 * role-only model granting a role *is* granting its permissions, so those events
 * would carry nothing the role events don't already carry. Clients that need to
 * know their own capability set moved get the point-to-point
 * `video_room.permission_updated` socket message instead.
 */
export const VIDEO_ROOM_ROLE_EVENTS = {
  ROLE_ASSIGNED: 'video_room.role_assigned',
  ROLE_REMOVED: 'video_room.role_removed',
  ROLE_UPDATED: 'video_room.role_updated',
  TEMPORARY_ROLE_GRANTED: 'video_room.temporary_role_granted',
  TEMPORARY_ROLE_EXPIRED: 'video_room.temporary_role_expired',
  OWNERSHIP_TRANSFERRED: 'video_room.ownership_transferred',
} as const;

/** An elevated in-room role was granted to a user. */
export class RoleAssignedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
  role: VideoRoomMemberRole;
  /** ISO-8601 when the grant is temporary; null when permanent. */
  expiresAt: string | null;
}> {
  readonly name = VIDEO_ROOM_ROLE_EVENTS.ROLE_ASSIGNED;
}

/** A user's elevated grant was revoked. */
export class RoleRemovedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
  role: VideoRoomMemberRole;
}> {
  readonly name = VIDEO_ROOM_ROLE_EVENTS.ROLE_REMOVED;
}

/** A user's elevated grant was replaced with a different role. */
export class RoleUpdatedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
  previousRole: VideoRoomMemberRole;
  role: VideoRoomMemberRole;
  expiresAt: string | null;
}> {
  readonly name = VIDEO_ROOM_ROLE_EVENTS.ROLE_UPDATED;
}

/**
 * A time-limited grant was issued (temporary admin / moderator). Published
 * alongside RoleAssignedEvent rather than instead of it, so consumers that only
 * care about "who holds what" need not special-case temporary grants.
 */
export class TemporaryRoleGrantedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
  role: VideoRoomMemberRole;
  expiresAt: string;
}> {
  readonly name = VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_GRANTED;
}

/**
 * A time-limited grant lapsed and was swept. Note this is an *announcement*, not
 * the revocation itself — the grant stopped granting anything the moment it
 * expired, because the repository's active-grant read filters on expiry.
 */
export class TemporaryRoleExpiredEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  role: VideoRoomMemberRole;
}> {
  readonly name = VIDEO_ROOM_ROLE_EVENTS.TEMPORARY_ROLE_EXPIRED;
}

/**
 * Room ownership moved. `reason` separates a deliberate handover from succession
 * after the owner departed, so audit review can tell the two apart without
 * inferring it from who the actor was.
 */
export class OwnershipTransferredEvent extends DomainEvent<{
  roomId: string;
  previousOwnerId: string;
  newOwnerId: string;
  actorId: string;
  reason: 'TRANSFER' | 'RECOVERY';
}> {
  readonly name = VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED;
}
