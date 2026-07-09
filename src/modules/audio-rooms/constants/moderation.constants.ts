/**
 * AR-3 moderation Redis keys + tuning. The DB (room_bans / room_mutes) is
 * authoritative; Redis holds the hot enforcement view so the join gate and mute
 * checks are O(1). Two structures per room: a SET of currently-banned/muted user
 * ids (fast membership test), plus a per-user string key with a PX TTL for
 * TEMPORARY actions so they self-expire even before the reconciliation sweep.
 * All keys are `{roomId}` hash-tagged for Cluster-safety.
 */

/** SET of user ids with an active ban in the room. */
export function roomBanSetKey(roomId: string): string {
  return `audio-room:{${roomId}}:bans`;
}

/** Per-user ban marker with a PX TTL (temporary bans auto-expire). */
export function roomBanKey(roomId: string, userId: string): string {
  return `audio-room:{${roomId}}:ban:${userId}`;
}

/** SET of user ids with an active mute in the room. */
export function roomMuteSetKey(roomId: string): string {
  return `audio-room:{${roomId}}:mutes`;
}

/** Per-user mute marker with a PX TTL (temporary mutes auto-expire). */
export function roomMuteKey(roomId: string, userId: string): string {
  return `audio-room:{${roomId}}:mute:${userId}`;
}

/** Per-room lock serialising moderation state transitions. */
export function moderationLockKey(roomId: string): string {
  return `audio-room:moderation:{${roomId}}`;
}

/** Lock guarding the fleet-wide ban/mute expiry sweep. */
export const MODERATION_MONITOR_LOCK_KEY = 'audio-room:moderation:monitor';

/** How often the expiry monitor reconciles expired bans/mutes. */
export const MODERATION_MONITOR_INTERVAL_MS = 15_000;

/**
 * Synthetic actor id for system-initiated moderation (e.g. AR-4 chat
 * auto-escalation). A fixed all-zero UUID so the `@db.Uuid` moderator column is
 * satisfied while remaining clearly distinguishable from a real user id.
 */
export const SYSTEM_MODERATOR_ID = '00000000-0000-0000-0000-000000000000';

/** Bounds for moderator-supplied text. */
export const MOD_REASON_MAX = 500;
export const MOD_NOTE_MAX = 1000;
export const MOD_DURATION_MIN_MINUTES = 1;
export const MOD_DURATION_MAX_MINUTES = 525_600; // 1 year
