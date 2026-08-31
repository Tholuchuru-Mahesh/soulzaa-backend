import { BackpackItemType } from '@prisma/client';

/**
 * Treasure box & rocket constants. Locks serialise contribution application +
 * auto-open per session / per rocket so concurrent gifts can't double-open a box
 * or race the progress counter.
 */

/** Number of sequential boxes in a treasure session. */
export const TREASURE_BOX_COUNT = 5;

/** Lock guarding a treasure session's progress + auto-open. */
export function treasureSessionLockKey(sessionId: string): string {
  return `treasure:session:${sessionId}`;
}

/** Lock guarding the "start session for a room" critical section. */
export function treasureRoomLockKey(roomId: string): string {
  return `treasure:room:{${roomId}}`;
}

/**
 * Redis key for the completed Treasure Champions snapshot for a room.
 * Written when a session finishes, cleared when a new session starts.
 * TTL = 25 hours (enough to bridge daily resets with a safety margin).
 */
export function treasureChampionsCacheKey(roomId: string): string {
  return `treasure:champions:${roomId}`;
}

/** TTL for the champions cache: 25 hours in seconds. */
export const TREASURE_CHAMPIONS_CACHE_TTL = 25 * 60 * 60;

/** Lock guarding a rocket event's contribution + completion. */
export function rocketLockKey(rocketId: string): string {
  return `rocket:{${rocketId}}`;
}

/** Lock guarding the "start rocket for a room" critical section. */
export function rocketRoomLockKey(roomId: string): string {
  return `rocket:room:{${roomId}}`;
}

/** Lock guarding the fleet-wide rocket expiry sweep. */
export const ROCKET_MONITOR_LOCK_KEY = 'rocket:monitor';

/** How often the rocket expiry monitor reconciles ended rockets. */
export const ROCKET_MONITOR_INTERVAL_MS = 5_000;

/**
 * One reward entry in a box/rocket config's reward list. COINS credits the
 * wallet (gold); BACKPACK_ITEM grants a backpack item. `rank` maps the reward to
 * the Nth Top gifter/contributor.
 */
export interface RewardEntry {
  rank: number;
  kind: 'COINS' | 'BACKPACK_ITEM';
  coins?: number;
  itemType?: BackpackItemType;
  itemName?: string;
  itemRefId?: string;
  transferable?: boolean;
  /**
   * Days the granted cosmetic stays with the winner before it expires and is
   * removed. `0` or omitted means permanent. Ignored for COINS.
   */
  ttlDays?: number;
}
