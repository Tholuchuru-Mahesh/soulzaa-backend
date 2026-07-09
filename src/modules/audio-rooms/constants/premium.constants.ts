/**
 * AR-9 premium-feature constants: locks serialising the premium-seat purchase +
 * expiry sweep, and the watch-party control lock.
 */

/** Lock guarding a premium-seat purchase for a (room,user). */
export function premiumSeatLockKey(roomId: string, userId: string): string {
  return `premium-seat:{${roomId}}:${userId}`;
}

/** Lock guarding watch-party control writes for a room. */
export function watchPartyLockKey(roomId: string): string {
  return `watch-party:{${roomId}}`;
}

/** Lock guarding the fleet-wide premium-seat expiry sweep. */
export const PREMIUM_SEAT_MONITOR_LOCK_KEY = 'premium-seat:monitor';

/** How often the premium-seat expiry monitor runs. */
export const PREMIUM_SEAT_MONITOR_INTERVAL_MS = 30_000;
