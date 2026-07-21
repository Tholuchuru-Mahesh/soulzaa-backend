/**
 * VR-9 chat constants: Redis key builders and fixed bounds. Tunables live in the
 * `videoRoomChat` config namespace; these are the fixed conventions shared across
 * the repository/service/listener tree. Every key is single-key and hash-tagged
 * on the room id, so every op is Redis-Cluster-safe.
 */

/** Ring buffer of recent messages (LPUSH + LTRIM) — read hot path. */
export function videoRoomChatRecentKey(roomId: string): string {
  return `video-room:{${roomId}}:chat:recent`;
}

/** Active pinned message ids. */
export function videoRoomChatPinsKey(roomId: string): string {
  return `video-room:{${roomId}}:chat:pins`;
}

/** Cached announcement payload. */
export function videoRoomChatAnnouncementsKey(roomId: string): string {
  return `video-room:{${roomId}}:chat:announcements`;
}

/** Typing roster: ZSET of userId → expiry epoch ms. */
export function videoRoomChatTypingKey(roomId: string): string {
  return `video-room:{${roomId}}:chat:typing`;
}

export function videoRoomChatRateKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:rate:${userId}`;
}

export function videoRoomChatSlowKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:slow:${userId}`;
}

export function videoRoomChatFloodKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:flood:${userId}`;
}

export function videoRoomChatDedupKey(roomId: string, userId: string, hash: string): string {
  return `video-room:{${roomId}}:chat:dedup:${userId}:${hash}`;
}

/** Active cooldown; presence blocks sending. */
export function videoRoomChatCooldownKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:cd:${userId}`;
}

/** Rolling violation counter driving the escalating cooldown ladder. */
export function videoRoomChatViolationKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:viol:${userId}`;
}

/** Write-through read cursor (throttles the Postgres upsert). */
export function videoRoomChatCursorKey(roomId: string, userId: string): string {
  return `video-room:{${roomId}}:chat:cursor:${userId}`;
}

/** Per-room lock serialising pin/unpin so the pin cap cannot be raced. */
export function videoRoomChatPinLockKey(roomId: string): string {
  return `video-room:chat:pin:{${roomId}}`;
}

// ---- Fixed bounds (mirrored by the DTOs) ----

/** Emoji-only messages get a tighter bound than the configurable text max. */
export const VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH = 64;
/** Hard ceiling on a search term. */
export const VIDEO_ROOM_CHAT_SEARCH_TERM_MAX = 100;
/** Matches `@username` (3–30 ASCII word chars). */
export const VIDEO_ROOM_CHAT_MENTION_RE = /@([a-zA-Z0-9_]{3,30})/g;
/** Group-mention tokens resolved to role sets rather than a single user. */
export const VIDEO_ROOM_CHAT_GROUP_MENTIONS = ['owner', 'admins'] as const;
