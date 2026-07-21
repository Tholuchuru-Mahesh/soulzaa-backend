/**
 * VR-8 — seat queue policy and Redis key layout.
 *
 * The queue itself is a Redis ZSET projection over the PENDING rows in
 * `video_room_seat_requests` (Postgres stays the record of truth). This file
 * holds the ONLY place queue ordering is decided, deliberately as a pure
 * function: no clock read, no I/O, no DI. Change the precedence here and the
 * whole product's queue policy changes, with unit tests that need no mocks.
 *
 * Lower score sorts first, matching the ascending `CacheService.sortedRank` /
 * `sortedLowest` (ZRANK / ZRANGE) primitives the queue service uses.
 */

/**
 * How many times an entry may be passed over before it is pinned to the front,
 * ahead of every VIP. Without this, a steady trickle of VIP requests starves
 * regular viewers indefinitely.
 */
export const QUEUE_FAIRNESS_SKIP_CAP = 3;

/** Highest VIP ordinal the platform issues (VipLevel NONE=0 … TITAN=7). */
const MAX_VIP_ORDINAL = 7;

/**
 * Weight of one VIP tier, in "milliseconds of queue advantage". Far larger than
 * any plausible queue age, so a VIP always outranks a non-VIP regardless of
 * arrival time — while still leaving arrival time as the tie-breaker within a
 * tier. 1e12 ms ≈ 31.7 years.
 */
const VIP_TIER_WEIGHT = 1e12;

/** Band offset applied to entries at the fairness cap, pulling them below every VIP band. */
const PINNED_BAND = -((MAX_VIP_ORDINAL + 1) * VIP_TIER_WEIGHT);

export interface QueueScoreInput {
  /** VIP tier ordinal; 0 when the user has no VIP. */
  vipLevel: number;
  /** Original request time — preserved across restore so position survives a reconnect. */
  createdAt: Date;
  /** How many times this entry has been passed over by `advance`. */
  skipCount: number;
}

/**
 * Queue score — lower sorts first. Precedence:
 *   1. an entry at/past `QUEUE_FAIRNESS_SKIP_CAP` is pinned ahead of everything
 *   2. otherwise a higher `vipLevel` sorts first
 *   3. ties break on earlier `createdAt`
 *
 * Degenerate inputs:
 *   - non-finite `vipLevel` (NaN, Infinity) is treated as `vipLevel: 0`
 *   - fractional `vipLevel` (e.g. 3.5) is floored to the lower tier
 *   - Invalid Date or non-finite `createdAt.getTime()` uses epoch (0) as arrival
 *
 * Valid inputs always produce the same score as today.
 */
export function computeQueueScore(input: QueueScoreInput): number {
  const { vipLevel, createdAt, skipCount } = input;

  // Defend against non-finite or invalid createdAt
  const arrivalTime = createdAt.getTime();
  const arrival = Number.isFinite(arrivalTime) ? arrivalTime : 0;

  if (skipCount >= QUEUE_FAIRNESS_SKIP_CAP) {
    // Pinned band: ordered among themselves by arrival, always below VIP bands.
    return PINNED_BAND + arrival;
  }

  // Defend against non-finite vipLevel and floor fractional values
  const safeVipLevel = Number.isFinite(vipLevel) ? Math.floor(vipLevel) : 0;
  const tier = Math.min(Math.max(safeVipLevel, 0), MAX_VIP_ORDINAL);
  return (MAX_VIP_ORDINAL - tier) * VIP_TIER_WEIGHT + arrival;
}

/**
 * ZSET of userId → queue score for a room's pending seat requests.
 * `{roomId}` is a Redis Cluster hash tag so this key and the skips key below
 * land in the same slot — `clear()` deletes both in one multi-key call.
 */
export function videoRoomSeatQueueKey(roomId: string): string {
  return `video-room:seatq:{${roomId}}`;
}

/**
 * ZSET of userId → skip count. A ZSET rather than a hash because `CacheService`
 * exposes no hash operations; `addScore` (ZINCRBY) increments and `score`
 * (ZSCORE) reads.
 */
export function videoRoomSeatQueueSkipsKey(roomId: string): string {
  return `video-room:seatq:{${roomId}}:skips`;
}
