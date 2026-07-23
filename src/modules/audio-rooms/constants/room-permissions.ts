import { RoomMemberRole } from '@prisma/client';

/**
 * Room-scoped permissions (distinct from platform PlatformRole permissions).
 * The permission matrix below is the single source of truth for what each
 * in-room role may do; RoomPermissionService resolves a user's effective role
 * and checks against this. Platform ADMIN/SUPER_ADMIN bypass all room checks.
 */
export enum RoomPermission {
  /** Configure the seat layout, lock/unlock seats, accept/reject mic requests. */
  MANAGE_SEATS = 'MANAGE_SEATS',
  /** Invite/move/remove speakers on the stage. */
  MANAGE_SPEAKERS = 'MANAGE_SPEAKERS',
  /** Moderate users (kick/restrict — moderation phase consumes this). */
  MODERATE_USERS = 'MODERATE_USERS',
  /** Mute individual seats. */
  MUTE_USERS = 'MUTE_USERS',
  /** Mute/unmute the whole room (all speaker seats). */
  ROOM_MUTE = 'ROOM_MUTE',
  /** Pin chat messages (chat phase consumes this). */
  PIN_MESSAGES = 'PIN_MESSAGES',
  /** Grant/revoke in-room roles (admin / premium admin / speaker). */
  GRANT_ROLES = 'GRANT_ROLES',
  /** Transfer room ownership. */
  TRANSFER_OWNERSHIP = 'TRANSFER_OWNERSHIP',
  /** Delete / end the room. */
  DELETE_ROOM = 'DELETE_ROOM',
}

const ADMIN_PERMISSIONS: readonly RoomPermission[] = [
  RoomPermission.MANAGE_SEATS,
  RoomPermission.MANAGE_SPEAKERS,
  RoomPermission.MODERATE_USERS,
  RoomPermission.MUTE_USERS,
  RoomPermission.ROOM_MUTE,
  RoomPermission.PIN_MESSAGES,
];

/**
 * Role → permission set (PRD + AR-1 spec matrix):
 *  - OWNER: full access.
 *  - ADMIN: moderate, manage speakers/seats, mute, pin, grant roles — NOT
 *    ownership transfer or room deletion.
 *  - PREMIUM_ADMIN: all Admin permissions (same exclusions). The distinction is
 *    the paid dedicated seat, not extra powers.
 *  - SPEAKER: no moderation permissions (mic/gifts/PK are seat-derived
 *    capabilities checked via isSpeaker, not entries here).
 *  - LISTENER (audience): no moderation permissions.
 */
export const ROOM_PERMISSION_MATRIX: Record<RoomMemberRole, ReadonlySet<RoomPermission>> = {
  [RoomMemberRole.OWNER]: new Set(Object.values(RoomPermission)),
  [RoomMemberRole.ADMIN]: new Set(ADMIN_PERMISSIONS),
  [RoomMemberRole.PREMIUM_ADMIN]: new Set(ADMIN_PERMISSIONS),
  [RoomMemberRole.SPEAKER]: new Set<RoomPermission>(),
  [RoomMemberRole.LISTENER]: new Set<RoomPermission>(),
  // Legacy/deprecated value kept for the non-destructive enum migration; treated
  // as a plain audience member.
  [RoomMemberRole.AUDIENCE]: new Set<RoomPermission>(),
};

/** The in-room roles that carry an elevated grant (stored in room_roles). */
export const ELEVATED_ROLES: readonly RoomMemberRole[] = [
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
];

export function isElevatedRole(role: RoomMemberRole): boolean {
  return ELEVATED_ROLES.includes(role);
}

export function roleHasPermission(role: RoomMemberRole, permission: RoomPermission): boolean {
  return ROOM_PERMISSION_MATRIX[role]?.has(permission) ?? false;
}
