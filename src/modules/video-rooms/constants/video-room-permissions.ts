import { VideoRoomMemberRole } from '@prisma/client';

/**
 * Video-room-scoped permissions (distinct from platform PlatformRole permissions).
 * The matrix below is the single source of truth for what each in-room role may do;
 * a VideoRoomPermissionService (later phase) resolves a user's effective role
 * (grant → seat occupancy → membership) and checks against this. Platform
 * ADMIN/SUPER_ADMIN bypass all room checks.
 *
 * Design decision (VR-1): permissions are a CODE matrix + a `video_room_roles`
 * grants table — NOT a database-driven permission table. This mirrors Audio Rooms
 * (`RoomPermission` / `ROOM_PERMISSION_MATRIX`): one testable source of truth, and
 * changing policy is a code change, not a data migration. `VideoRoomBan` is not a
 * permission — the Video Room has no ban feature; BLOCK_USERS covers barring.
 */
export enum VideoRoomPermission {
  /** Configure the seat layout, lock/unlock seats, accept/reject seat requests. */
  MANAGE_SEATS = 'MANAGE_SEATS',
  /** Invite / move / remove hosts & participants on the stage. */
  MANAGE_PARTICIPANTS = 'MANAGE_PARTICIPANTS',
  /** Remove a user from the room (kick). */
  KICK_USERS = 'KICK_USERS',
  /** Block a user from the room (durable blocklist) and lift blocks. */
  BLOCK_USERS = 'BLOCK_USERS',
  /** Mute an individual member. */
  MUTE_USERS = 'MUTE_USERS',
  /** Mute/unmute the whole room. */
  ROOM_MUTE = 'ROOM_MUTE',
  /** Pin chat messages (chat phase consumes this). */
  PIN_MESSAGES = 'PIN_MESSAGES',
  /** Grant/revoke in-room roles (admin / moderator / host). */
  GRANT_ROLES = 'GRANT_ROLES',
  /** Change the room theme / background. */
  CHANGE_THEME = 'CHANGE_THEME',
  /** Lock/unlock the room (password / gift lock). */
  LOCK_ROOM = 'LOCK_ROOM',
  /** Post/pin/remove room announcements. */
  MANAGE_ANNOUNCEMENTS = 'MANAGE_ANNOUNCEMENTS',
  /** Start/stop PK battles. */
  START_PK = 'START_PK',
  /** View room analytics. */
  VIEW_ANALYTICS = 'VIEW_ANALYTICS',
  /** Invite users to the room. */
  INVITE_USERS = 'INVITE_USERS',
  /** Transfer room ownership. */
  TRANSFER_OWNERSHIP = 'TRANSFER_OWNERSHIP',
  /** Close / end the room. */
  CLOSE_ROOM = 'CLOSE_ROOM',
}

/**
 * ADMIN gets everything an owner can do EXCEPT the two irreversible,
 * owner-only powers (transfer ownership, close the room) — mirrors Audio Rooms'
 * admin exclusions.
 */
const ADMIN_PERMISSIONS: readonly VideoRoomPermission[] = Object.values(VideoRoomPermission).filter(
  (p) => p !== VideoRoomPermission.TRANSFER_OWNERSHIP && p !== VideoRoomPermission.CLOSE_ROOM,
);

/**
 * MODERATOR is a behaviour/content moderator: it can discipline users and manage
 * chat/announcements, but NOT reshape the room (seats, roles, theme, lock, PK,
 * analytics). This is the key ADMIN-vs-MODERATOR split — adjust the set below if
 * moderators in your product should also manage seats or start PK.
 */
const MODERATOR_PERMISSIONS: readonly VideoRoomPermission[] = [
  VideoRoomPermission.KICK_USERS,
  VideoRoomPermission.BLOCK_USERS,
  VideoRoomPermission.MUTE_USERS,
  VideoRoomPermission.ROOM_MUTE,
  VideoRoomPermission.PIN_MESSAGES,
  VideoRoomPermission.MANAGE_ANNOUNCEMENTS,
];

/**
 * Role → permission set. OWNER: full access. ADMIN: all but ownership
 * transfer / room close. MODERATOR: moderation subset. HOST / PARTICIPANT /
 * VIEWER: no management permissions (their media capabilities — publishing,
 * camera, mic — are seat-derived, checked via seat occupancy, not entries here).
 */
export const VIDEO_ROOM_PERMISSION_MATRIX: Record<
  VideoRoomMemberRole,
  ReadonlySet<VideoRoomPermission>
> = {
  [VideoRoomMemberRole.OWNER]: new Set(Object.values(VideoRoomPermission)),
  [VideoRoomMemberRole.ADMIN]: new Set(ADMIN_PERMISSIONS),
  [VideoRoomMemberRole.MODERATOR]: new Set(MODERATOR_PERMISSIONS),
  [VideoRoomMemberRole.HOST]: new Set<VideoRoomPermission>(),
  [VideoRoomMemberRole.PARTICIPANT]: new Set<VideoRoomPermission>(),
  [VideoRoomMemberRole.VIEWER]: new Set<VideoRoomPermission>(),
};

/** In-room roles that carry an elevated grant (persisted in video_room_roles). */
export const ELEVATED_VIDEO_ROOM_ROLES: readonly VideoRoomMemberRole[] = [
  VideoRoomMemberRole.OWNER,
  VideoRoomMemberRole.ADMIN,
  VideoRoomMemberRole.MODERATOR,
];

export function isElevatedVideoRoomRole(role: VideoRoomMemberRole): boolean {
  return ELEVATED_VIDEO_ROOM_ROLES.includes(role);
}

export function videoRoomRoleHasPermission(
  role: VideoRoomMemberRole,
  permission: VideoRoomPermission,
): boolean {
  return VIDEO_ROOM_PERMISSION_MATRIX[role]?.has(permission) ?? false;
}
