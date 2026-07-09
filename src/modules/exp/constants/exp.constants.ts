/**
 * EXP module constants: the reward-entry shape shared by level configs, and the
 * per-user/per-room lock keys that serialise EXP application + level-up so
 * concurrent awards can't double-grant a level's rewards.
 */

/**
 * One reward granted on reaching a level. COINS credits the wallet (GOLD or
 * FREE — level rewards default to FREE coins); COSMETIC grants a catalog
 * cosmetic (frame/badge/entrance-effect) into the backpack.
 */
export interface RewardEntry {
  kind: 'COINS' | 'COSMETIC';
  coins?: number;
  currency?: 'GOLD' | 'FREE';
  cosmeticId?: string;
}

/** Lock guarding a user's EXP application + level-up. */
export function userExpLockKey(userId: string): string {
  return `exp:user:${userId}`;
}

/** Lock guarding a room's EXP application + level-up. */
export function roomExpLockKey(roomId: string): string {
  return `exp:room:{${roomId}}`;
}
