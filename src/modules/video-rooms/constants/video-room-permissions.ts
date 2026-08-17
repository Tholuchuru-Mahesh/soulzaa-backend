import { VideoRoomMemberRole } from '@prisma/client';

/**
 * Video-room-scoped permissions (distinct from platform PlatformRole permissions).
 * The matrix below is the single source of truth for what each in-room role may do;
 * VideoRoomPermissionService resolves a user's effective role (owner → grant →
 * seat occupancy) and checks against this. Platform ADMIN/SUPER_ADMIN bypass all
 * room checks.
 *
 * Design decision (VR-1, re-affirmed VR-7): permissions are a CODE matrix + a
 * `video_room_roles` grants table — NOT a database-driven permission table. This
 * mirrors Audio Rooms (`RoomPermission` / `ROOM_PERMISSION_MATRIX`): one testable
 * source of truth, and changing policy is a code change, not a data migration.
 * `VideoRoomBan` is not a permission — the Video Room has no ban feature;
 * BLOCK_USERS covers barring.
 */
export enum VideoRoomPermission {
  /**
   * Edit the room profile, settings and category — the room's identity. VR-7
   * introduced this to replace the coarse `assertCanManage` gate, which admitted
   * ADMIN and so made the PRD's "Admins CANNOT edit room profile" restriction
   * impossible to express. Owner-only.
   */
  MANAGE_ROOM = 'MANAGE_ROOM',
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
  /** Review/dismiss reports, add investigation notes, list the report queue. */
  REVIEW_REPORTS = 'REVIEW_REPORTS',
  /** Pin chat messages (chat phase consumes this). */
  PIN_MESSAGES = 'PIN_MESSAGES',
  /**
   * Grant/revoke in-room roles. Owner-only per the PRD: "Only the Room Owner can
   * appoint Admins" and "Admins CANNOT add or remove admins".
   */
  GRANT_ROLES = 'GRANT_ROLES',
  /** Change the room theme / background. */
  CHANGE_THEME = 'CHANGE_THEME',
  /** Lock/unlock the room (password / gift lock). */
  LOCK_ROOM = 'LOCK_ROOM',
  /** Post/pin/remove room announcements. */
  MANAGE_ANNOUNCEMENTS = 'MANAGE_ANNOUNCEMENTS',
  /** Start/stop PK battles. */
  START_PK = 'START_PK',
  /**
   * Create / start / pause / resume / close / archive the treasure ladder
   * (VR-11). Owner and admin: the PRD's "Only the room owner or authorized
   * admin can create a Treasure Box" (production.txt:1291).
   */
  MANAGE_TREASURE = 'MANAGE_TREASURE',
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
 * MODERATOR is a behaviour/content moderator: it can discipline users and manage
 * chat/announcements, but NOT reshape the room (seats, roles, theme, lock, PK,
 * analytics). This is the key ADMIN-vs-MODERATOR split.
 */
const MODERATOR_PERMISSIONS: readonly VideoRoomPermission[] = [
  VideoRoomPermission.KICK_USERS,
  VideoRoomPermission.BLOCK_USERS,
  VideoRoomPermission.MUTE_USERS,
  VideoRoomPermission.ROOM_MUTE,
  VideoRoomPermission.PIN_MESSAGES,
  VideoRoomPermission.MANAGE_ANNOUNCEMENTS,
  VideoRoomPermission.REVIEW_REPORTS,
];

/**
 * ADMIN is the PRD's Room Admin (production.txt:3349-3372): accept/reject seat
 * requests, invite to seats, remove from seats, mute, kick, pin, manage the
 * speaking queue. The PRD's "Admin Restrictions" section explicitly bars room
 * profile (MANAGE_ROOM), password/lock (LOCK_ROOM), admin appointment
 * (GRANT_ROLES) and category/theme (CHANGE_THEME) — all of which stay owner-only.
 *
 * Built by extending MODERATOR_PERMISSIONS rather than listing them again, which
 * is what makes "each role is a superset of the one below it" true by
 * construction instead of by convention.
 */
const ADMIN_PERMISSIONS: readonly VideoRoomPermission[] = [
  ...MODERATOR_PERMISSIONS,
  VideoRoomPermission.MANAGE_SEATS,
  VideoRoomPermission.MANAGE_PARTICIPANTS,
  VideoRoomPermission.INVITE_USERS,
  VideoRoomPermission.VIEW_ANALYTICS,
  VideoRoomPermission.START_PK,
  VideoRoomPermission.MANAGE_TREASURE,
];

/**
 * Role → permission set. OWNER: full access. ADMIN: the PRD admin duties.
 * MODERATOR: moderation subset. HOST / PARTICIPANT / VIEWER: no management
 * permissions (their media capabilities — publishing, camera, mic — are
 * seat-derived, checked via seat occupancy, not entries here).
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

/**
 * Numeric authority for role-hierarchy guards (higher outranks lower). The single
 * source of truth — VideoRoomPermissionService and VideoRoomRoleService both read
 * this rather than keeping private copies that could drift apart.
 */
export const VIDEO_ROOM_ROLE_RANK: Record<VideoRoomMemberRole, number> = {
  [VideoRoomMemberRole.OWNER]: 5,
  [VideoRoomMemberRole.ADMIN]: 4,
  [VideoRoomMemberRole.MODERATOR]: 3,
  [VideoRoomMemberRole.HOST]: 2,
  [VideoRoomMemberRole.PARTICIPANT]: 1,
  [VideoRoomMemberRole.VIEWER]: 0,
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

/**
 * A role's permissions as a stable, sorted array — the shape cached in Redis and
 * returned by the API. Sorted so a cached payload is byte-identical across
 * instances, which keeps cache entries comparable in tests and logs.
 */
export function videoRoomRolePermissions(role: VideoRoomMemberRole): VideoRoomPermission[] {
  return [...(VIDEO_ROOM_PERMISSION_MATRIX[role] ?? [])].sort();
}
