/**
 * Gifts module constants: Redis key builders for the combo counter, the send
 * rate limiter, and the top-gifter/top-receiver leaderboards, plus fixed
 * numeric bounds. Configurable tuning (creator-earning rate, EXP rates, rate
 * window, max quantity) lives in the `gift` config namespace.
 */

/** Leaderboard time windows (PRD rankings: daily/weekly/monthly/all-time). */
export enum LeaderboardPeriod {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  ALL_TIME = 'all_time',
}

/** Which side of a gift a leaderboard ranks. */
export enum LeaderboardBoard {
  GIFTER = 'gifter',
  RECEIVER = 'receiver',
  /** Ranks senders (fans) by coins given to one specific creator — see FANS scope. */
  FANS = 'fans',
}

/** Leaderboard scope: platform-wide, a single room/context, or one creator's
 *  own fans (Creator Center — Top Fans; always cross-room by definition). */
export enum LeaderboardScope {
  GLOBAL = 'global',
  ROOM = 'room',
  CREATOR = 'creator',
}

/**
 * Combo counter: increments each time the same sender sends the same combo-
 * enabled gift within the gift's combo window; the TTL is the window, so a lapse
 * resets the tier. Hash-tagged by context so it stays on one Cluster slot.
 */
export function giftComboKey(contextId: string, senderId: string, giftId: string): string {
  return `gift:combo:{${contextId}}:${senderId}:${giftId}`;
}

/** Rolling send-rate window per sender (anti-abuse). */
export function giftRateKey(senderId: string): string {
  return `gift:rate:${senderId}`;
}

/**
 * Leaderboard ZSET key. `scopeId` is the roomId for ROOM scope (ignored for
 * GLOBAL). `bucket` is the period bucket (e.g. `2026-07-07`, `all`).
 */
export function giftLeaderboardKey(
  board: LeaderboardBoard,
  scope: LeaderboardScope,
  scopeId: string | null,
  bucket: string,
): string {
  const scopePart =
    scope === LeaderboardScope.ROOM
      ? `room:{${scopeId}}`
      : scope === LeaderboardScope.CREATOR
        ? `creator:{${scopeId}}`
        : 'global';
  return `gift:lb:${scopePart}:${board}:${bucket}`;
}

/** Hard cap on a single send's quantity (DTO also enforces this). */
export const GIFT_MAX_QUANTITY = 999;

/** Default number of entries returned by a leaderboard read. */
export const GIFT_LEADERBOARD_DEFAULT_LIMIT = 50;
export const GIFT_LEADERBOARD_MAX_LIMIT = 100;

/** Reference type recorded on the wallet ledger for gift movements. */
export const GIFT_WALLET_REFERENCE_TYPE = 'gift';
