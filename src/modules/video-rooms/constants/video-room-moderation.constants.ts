/**
 * Video Room Phase 16 moderation constants: Redis key builders for the
 * mute/block enforcement mirror + the auto-moderation windowed counters, the
 * fleet-wide expiry-monitor lock, the system-moderator sentinel id, the
 * client-facing moderation socket event names, the 3 BullMQ queue names, and
 * fixed text/metadata bounds. Config-driven thresholds (spam/flood/etc.
 * windows + limits) live in the `videoRoom.moderation` config namespace (see
 * config/configuration.ts) — these are the fixed conventions shared across
 * the moderation repository/service/listener/monitor tree.
 *
 * Mirrors `src/modules/audio-rooms/constants/moderation.constants.ts` (key
 * builder + hash-tag conventions, `SYSTEM_MODERATOR_ID`), adapted to the
 * `video-room:` prefix and this module's own enforcement surface (no ban —
 * Video Room moderation is kick/blacklist/mute/warn/report only).
 */

// ---- Redis keys (single-key ops → Cluster-safe; hash-tag the room id) ----

/** SET mirror of users with an active mute in the room (fast enforcement). */
export function mutesMirrorKey(roomId: string): string {
  return `video-room:{${roomId}}:mutes`;
}

/** SET mirror of users with an active blacklist entry in the room (join-gate). */
export function blocksMirrorKey(roomId: string): string {
  return `video-room:{${roomId}}:blocks`;
}

/** SET mirror of users with an active kick entry in the room (join-gate). */
export function kicksMirrorKey(roomId: string): string {
  return `video-room:{${roomId}}:kicks`;
}

/** Per-room lock serialising moderation command mutations (kick/mute/block/…). */
export function moderationLockKey(roomId: string): string {
  return `video-room:moderation:{${roomId}}`;
}

/** Fleet-wide lock so exactly one instance runs the mute-expiry sweep. */
export const MODERATION_MONITOR_LOCK_KEY = 'video-room:moderation:monitor';

/** Windowed message-count counter feeding the spam detector (INCR + EXPIRE). */
export function spamCounterKey(roomId: string, userId: string): string {
  return `video-room:mod:spam:{${roomId}}:${userId}`;
}

/** Windowed message-count counter feeding the flood detector. */
export function floodCounterKey(roomId: string, userId: string): string {
  return `video-room:mod:flood:{${roomId}}:${userId}`;
}

/** Last-content-hash / dedup marker feeding the duplicate-message detector. */
export function dupKey(roomId: string, userId: string): string {
  return `video-room:mod:dup:{${roomId}}:${userId}`;
}

/** Windowed join/leave-cycle counter feeding the rapid-join-leave detector. */
export function joinLeaveKey(roomId: string, userId: string): string {
  return `video-room:mod:joinleave:{${roomId}}:${userId}`;
}

/** Windowed report counter (reports received against a target) feeding the excessive-reports detector. */
export function reportCounterKey(roomId: string, userId: string): string {
  return `video-room:mod:reports:{${roomId}}:${userId}`;
}

/** Per-user auto-action cooldown flag (TTL) — suppresses repeat auto-actions. */
export function cooldownKey(roomId: string, userId: string): string {
  return `video-room:mod:cooldown:{${roomId}}:${userId}`;
}

/**
 * Synthetic actor id for system-initiated moderation (auto-mute/auto-kick/
 * auto-flag). A fixed all-zero UUID so the `@db.Uuid` moderator column is
 * satisfied while remaining clearly distinguishable from a real user id.
 * Matches `audio-rooms`' `SYSTEM_MODERATOR_ID` value.
 */
export const SYSTEM_MODERATOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Client-facing realtime event names the moderation socket listener emits.
 * Deliberately flat/camelCase (not the `video_room.*` dot-namespace used by
 * `VIDEO_ROOM_SOCKET_EVENTS`) to match the moderation surface's own event
 * naming as specified by the Phase 16 design.
 */
export const VIDEO_ROOM_MODERATION_SOCKET_EVENTS = {
  USER_KICKED: 'userKicked',
  USER_UNKICKED: 'userUnkicked',
  USER_BLACKLISTED: 'userBlacklisted',
  USER_UNBLACKLISTED: 'userUnblacklisted',
  USER_MUTED: 'userMuted',
  USER_UNMUTED: 'userUnmuted',
  USER_WARNED: 'userWarned',
  USER_FORCE_DISCONNECTED: 'userForceDisconnected',
  USER_REPORTED: 'userReported',
  REPORT_REVIEWED: 'reportReviewed',
  ROOM_MODERATION_UPDATED: 'roomModerationUpdated',
} as const;

export type VideoRoomModerationSocketEvent =
  (typeof VIDEO_ROOM_MODERATION_SOCKET_EVENTS)[keyof typeof VIDEO_ROOM_MODERATION_SOCKET_EVENTS];

// ---- BullMQ queues ----

/**
 * The 3 moderation-specific queues: async notify/enforcement dispatch, report
 * intake/aggregation, and retention/expiry housekeeping. Re-exported into the
 * shared `VIDEO_ROOM_QUEUES` map (see `video-room.constants.ts`) so producers
 * can reach every video-room queue name from a single import; declared here
 * as the single source of truth for the moderation subsystem.
 */
export const VIDEO_ROOM_MODERATION_QUEUES = {
  PROCESSING: 'video-rooms-moderation',
  REPORT: 'video-rooms-report',
  CLEANUP: 'video-rooms-moderation-cleanup',
} as const;

// ---- Fixed bounds (mirrored by the DTOs) ----

/** Hard ceiling on a report's free-text description. */
export const VIDEO_ROOM_MODERATION_DESCRIPTION_MAX = 1000;

/** Hard ceiling on a warning's stringified `metadata` JSON payload. */
export const VIDEO_ROOM_MODERATION_WARNING_METADATA_MAX = 2000;
