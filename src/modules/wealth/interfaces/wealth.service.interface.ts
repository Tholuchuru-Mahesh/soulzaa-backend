/**
 * Public contract for the Wealth Level module — the ONLY surface other
 * modules may depend on, alongside the EVENT_BUS. Wealth Level is driven by
 * monthly Gold-coin purchase EXP; gifts/video-rooms/events use
 * `getEffectiveLevel` to gate Wealth-Level-exclusive features, exactly as
 * they used `IVipService.getLevelOrdinal` before.
 */
export const WEALTH_SERVICE = Symbol('WEALTH_SERVICE');

/** A user's current Wealth Level snapshot. */
export interface WealthStatusView {
  userId: string;
  level: number;
  levelName: string;
  currentExp: number;
  periodKey: string;
  nextLevel: number | null;
  nextLevelName: string | null;
  nextLevelExp: number | null;
  remainingExp: number | null;
  progressPct: number | null;
}

export interface IWealthService {
  /** A user's current effective Wealth Level ordinal (0=Normal User .. 12=Immortal). */
  getEffectiveLevel(userId: string): Promise<number>;

  /** A user's full Wealth Level snapshot for the current month. */
  getStatus(userId: string): Promise<WealthStatusView>;
}
