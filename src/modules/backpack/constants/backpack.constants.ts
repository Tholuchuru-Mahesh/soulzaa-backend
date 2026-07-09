import { BackpackItemType } from '@prisma/client';

/**
 * Backpack constants. Equippable types allow at most one equipped item per type
 * per user (the service unequips the previous one on equip). The per-user lock
 * serialises equip/transfer so concurrent actions can't double-equip.
 */
export const EQUIPPABLE_TYPES: ReadonlySet<BackpackItemType> = new Set([
  BackpackItemType.FRAME,
  BackpackItemType.THEME,
  BackpackItemType.ENTRANCE_EFFECT,
  BackpackItemType.BADGE,
]);

/** Backpack log action names (append-only history). */
export const BACKPACK_ACTIONS = {
  GRANTED: 'granted',
  EQUIPPED: 'equipped',
  UNEQUIPPED: 'unequipped',
  TRANSFERRED_OUT: 'transferred_out',
  TRANSFERRED_IN: 'transferred_in',
} as const;

/** Lock guarding equip/transfer for a single user's backpack. */
export function backpackLockKey(userId: string): string {
  return `backpack:lock:${userId}`;
}
