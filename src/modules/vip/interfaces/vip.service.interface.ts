import type { VipLevel } from '@prisma/client';

/**
 * Public contract for the VIP module — the ONLY surface other modules may
 * depend on, alongside the EVENT_BUS. VIP tier is driven by lifetime Gold-coin
 * recharge; gifts use `getLevelOrdinal` to gate VIP-exclusive gifts, and the
 * payments/recharge flow reports purchases via `recordRecharge`.
 */
export const VIP_SERVICE = Symbol('VIP_SERVICE');

/** A user's VIP snapshot. */
export interface VipStatusView {
  userId: string;
  level: VipLevel;
  ordinal: number;
  lifetimeRecharge: number;
  nextLevel: VipLevel | null;
  nextLevelRecharge: number | null;
}

export interface IVipService {
  /** A user's current VIP tier + lifetime recharge. */
  getStatus(userId: string): Promise<VipStatusView>;

  /** A user's VIP tier ordinal (NONE=0 … TITAN=7) — the gift gate uses this. */
  getLevelOrdinal(userId: string): Promise<number>;

  /**
   * Add a Gold-coin recharge to VIP progress (idempotent on `idempotencyKey`);
   * auto-upgrades the tier and grants benefits when a threshold is crossed.
   */
  recordRecharge(input: {
    userId: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<{ level: VipLevel; upgraded: boolean }>;
}
