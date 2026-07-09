/**
 * Audio Room chat (AR-4) constants: Redis key builders for the anti-abuse
 * layer (rate limit, slow-mode cooldown, duplicate suppression, violation
 * history) and small fixed limits. All keys hash-tag the room id `{roomId}`
 * so every op stays on a single Cluster slot. Configurable numeric bounds
 * (max length, rate windows, thresholds) live in the `audioRoom.chat` config
 * namespace; the values here are fixed conventions.
 */

/** Rolling message-rate counter (per user, per room). */
export function chatRateKey(roomId: string, userId: string): string {
  return `audio-room:chat:{${roomId}}:rate:${userId}`;
}

/** Slow-mode cooldown marker (present ⇒ still cooling down). */
export function chatSlowModeKey(roomId: string, userId: string): string {
  return `audio-room:chat:{${roomId}}:slow:${userId}`;
}

/** Duplicate-suppression marker keyed by a content hash. */
export function chatDedupKey(roomId: string, userId: string, contentHash: string): string {
  return `audio-room:chat:{${roomId}}:dup:${userId}:${contentHash}`;
}

/** Rolling blocked-word violation counter feeding auto mute/kick thresholds. */
export function chatViolationKey(roomId: string, userId: string): string {
  return `audio-room:chat:{${roomId}}:viol:${userId}`;
}

/** Ephemeral reaction-burst rate counter (per user, per room). */
export function chatReactRateKey(roomId: string, userId: string): string {
  return `audio-room:chat:{${roomId}}:react:${userId}`;
}

/** Lock serialising pin/unpin writes for a room. */
export function chatPinLockKey(roomId: string): string {
  return `audio-room:chat:pin:{${roomId}}`;
}

/** Emoji reactions accepted by `chat.react` (floating burst). */
export const CHAT_REACTION_EMOJIS = ['❤️', '😂', '👍', '👏', '🔥', '😮', '😢', '🎉', '💯', '🙏'];

/** A single grapheme/emoji token cap for the `EMOJI` message type. */
export const CHAT_EMOJI_MESSAGE_MAX_LENGTH = 16;

/** Mask token substituted for a MILD blocked word. */
export const CHAT_MASK_TOKEN = '****';

/**
 * Absolute upper bound enforced at the DTO layer (defence in depth). The
 * operational limit is `audioRoom.chat.messageMaxLength` (config, default 1000)
 * and is enforced in the service as `MESSAGE_TOO_LONG`.
 */
export const CHAT_MESSAGE_HARD_MAX = 4000;

/** GIF/announcement field bounds. */
export const CHAT_GIF_URL_MAX = 2048;
export const CHAT_ANNOUNCEMENT_MAX = 1000;
export const CHAT_REPORT_DESCRIPTION_MAX = 500;
export const CHAT_BLOCKED_WORD_PATTERN_MAX = 200;
export const CHAT_BLOCKED_WORD_NOTES_MAX = 500;
