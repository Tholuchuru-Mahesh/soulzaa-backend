import type { Gift, GiftContextType } from '@prisma/client';

/**
 * Public contract for the gifts module — the ONLY surface other modules
 * (audio/video rooms, live streaming, treasure boxes) may depend on, alongside
 * the EVENT_BUS and published gift events. Internals stay private. The gift-send
 * flow itself is invoked through the gifts REST controller; this read seam lets
 * other domains resolve catalog data.
 */
export const GIFTS_SERVICE = Symbol('GIFTS_SERVICE');

export interface IGiftsService {
  /** A catalog gift by id, or null if missing. */
  getGift(giftId: string): Promise<Gift | null>;

  /** True when the gift exists and is enabled. */
  isGiftEnabled(giftId: string): Promise<boolean>;

  /** All enabled catalog gifts (ordered for display). */
  listActiveGifts(): Promise<Gift[]>;

  /** Total gift coins received in a context (e.g. a room) within a time window. */
  getContextCoinsInRange(
    contextType: GiftContextType,
    contextId: string,
    start: Date,
    end: Date,
  ): Promise<bigint>;

  /** Creator Center — Top Fans: who has given `creatorId` the most, ranked. */
  getTopFans(
    creatorId: string,
    period: 'today' | 'week' | 'month' | 'all',
    limit: number,
  ): Promise<TopFanEntry[]>;
}

/** One ranked fan — identity (avatar/username/level) is hydrated by the caller. */
export interface TopFanEntry {
  rank: number;
  userId: string;
  totalCoins: number;
  giftCount: number;
  lastGiftAt: Date | null;
}
