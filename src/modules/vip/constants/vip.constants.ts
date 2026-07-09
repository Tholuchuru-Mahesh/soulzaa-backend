import { VipLevel } from '@prisma/client';

/**
 * VIP tier order (ascending rank). The array index IS the tier ordinal, used to
 * compare a user's tier against a gift's `minVipLevel` and to find the highest
 * tier reached for a given lifetime recharge.
 */
export const VIP_LEVEL_ORDER: VipLevel[] = [
  VipLevel.NONE,
  VipLevel.BRONZE,
  VipLevel.SILVER,
  VipLevel.GOLD,
  VipLevel.PLATINUM,
  VipLevel.DIAMOND,
  VipLevel.ELITE,
  VipLevel.TITAN,
];

/** Ordinal (rank) of a VIP tier; NONE = 0 … TITAN = 7. */
export function vipOrdinal(level: VipLevel): number {
  const i = VIP_LEVEL_ORDER.indexOf(level);
  return i < 0 ? 0 : i;
}

/** Lock guarding a user's recharge accrual + tier upgrade. */
export function vipLockKey(userId: string): string {
  return `vip:user:${userId}`;
}

/** One VIP benefit: a granted cosmetic or a descriptive perk. */
export interface VipBenefit {
  kind: 'COSMETIC' | 'PERK';
  cosmeticId?: string;
  description?: string;
}
