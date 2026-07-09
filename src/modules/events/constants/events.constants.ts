/**
 * Events module constants: the reward-entry shape shared by event configs and
 * the per-user/event claim lock.
 */

/** One event reward: free/gold coins, a catalog cosmetic, or EXP. */
export interface EventRewardEntry {
  kind: 'COINS' | 'COSMETIC' | 'EXP';
  coins?: number;
  currency?: 'GOLD' | 'FREE';
  cosmeticId?: string;
  exp?: number;
}

/** Optional eligibility gate for claiming an event. */
export interface EventEligibility {
  minUserLevel?: number;
  minVipLevel?: number;
}

/** Lock guarding a user's claim of a specific event. */
export function eventClaimLockKey(eventId: string, userId: string): string {
  return `event:claim:${eventId}:${userId}`;
}
