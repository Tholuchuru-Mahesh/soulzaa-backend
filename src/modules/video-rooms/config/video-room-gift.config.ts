import type { ConfigService } from '@nestjs/config';

/**
 * Typed view of the `videoRoomGift` config namespace.
 *
 * Namespaced config surfaces as raw process.env strings at runtime, so every
 * value is re-coerced here once — the same approach `video-room.config.ts` takes
 * for numbers, extended to booleans. That extension matters: the repo-wide
 * `z.coerce.boolean()` idiom turns the STRING "false" into `true` (any non-empty
 * string is truthy), so an operator writing `VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL=false`
 * would silently enable room-wide gifting. `toBool` below treats the literal
 * strings "false"/"0"/"" as false, which is what an operator means.
 */
export interface VideoRoomGiftConfig {
  /** Cap on receivers per send (MULTI / SEAT_ALL). */
  maxReceivers: number;
  /** Whether the future-ready ROOM_ALL target is accepted. */
  allowRoomAll: boolean;
  /** Default for `video_room_settings.metadata.allowViewerGifts`. */
  allowViewerGiftsDefault: boolean;
  /** Capped length of the recent-gift feed. */
  recentFeedSize: number;
  /** Monitor tick: combo-ended sweep + optional DLQ replay. */
  monitorIntervalSeconds: number;
  /** Whether the monitor automatically replays dead-lettered delivery jobs. */
  recoveryEnabled: boolean;
  /**
   * Upper-cased ISO-3166-1 alpha-2 codes barred from gifting.
   *
   * Platform-level rather than per-gift: the `gifts` table has neither a country
   * column nor a metadata column, so per-gift country rules would need a
   * migration — which this phase forbids. The sender's country comes from
   * `video_room_members.country`, captured at join.
   */
  blockedCountries: string[];
}

interface RawVideoRoomGiftConfig {
  maxReceivers: number | string;
  allowRoomAll: boolean | string;
  allowViewerGiftsDefault: boolean | string;
  recentFeedSize: number | string;
  monitorIntervalSeconds: number | string;
  recoveryEnabled: boolean | string;
  blockedCountries: string | string[];
}

/**
 * Coerce an env-shaped value to a boolean. Unlike `Boolean(value)`, the strings
 * "false", "0" and "" are false — env vars arrive as strings, and every one of
 * those spellings means "off" to the person who wrote it.
 */
export function toBool(value: boolean | string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(normalized);
}

/**
 * Parse a comma-separated country list into upper-cased codes. Blank entries are
 * dropped so a trailing comma cannot produce an empty code that matches nothing
 * — or worse, matches a member whose country is unset.
 */
export function toCountryList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return parts.map((part) => part.trim().toUpperCase()).filter((part) => part.length > 0);
}

/** Read + coerce the `videoRoomGift` namespace. */
export function loadVideoRoomGiftConfig(config: ConfigService): VideoRoomGiftConfig {
  const raw = config.get<RawVideoRoomGiftConfig>('videoRoomGift');
  if (!raw) {
    throw new Error('videoRoomGift config namespace is not registered');
  }
  return {
    maxReceivers: Number(raw.maxReceivers),
    allowRoomAll: toBool(raw.allowRoomAll, false),
    allowViewerGiftsDefault: toBool(raw.allowViewerGiftsDefault, true),
    recentFeedSize: Number(raw.recentFeedSize),
    monitorIntervalSeconds: Number(raw.monitorIntervalSeconds),
    recoveryEnabled: toBool(raw.recoveryEnabled, false),
    blockedCountries: toCountryList(raw.blockedCountries),
  };
}
