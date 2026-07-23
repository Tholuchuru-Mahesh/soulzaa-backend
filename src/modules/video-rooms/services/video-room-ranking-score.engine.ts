import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';

export interface HostMetrics {
  coins: number;
  gifts: number;
  watchSeconds: number;
  peakViewers: number;
  pkWins: number;
  treasureEvents: number;
}

export interface RoomMetrics {
  giftCoins: number;
  peakViewers: number;
  avgWatchSeconds: number;
  pkCount: number;
  treasureCount: number;
}

export interface PkMetrics {
  wins: number;
  losses: number;
  score: number;
  giftCoins: number;
}

/**
 * Every metric any dimension can carry. Partial by design: the incremental path
 * knows one signal at a time (a gift's coins), while the recompute path knows
 * all of them — and both must be able to call the same function.
 */
export type RankingMetrics = Partial<HostMetrics & RoomMetrics & PkMetrics> & {
  coinsSpent?: number;
  coinsReceived?: number;
  treasureCoins?: number;
  vipOrdinal?: number;
};

/** VIP level dominates spend: one level is worth more than any tiebreak can be. */
const VIP_LEVEL_STRIDE = 1_000_000_000;

/**
 * Turns a metric bag into the single number a ZSET can hold.
 *
 * This is the ONLY place weights are applied. The incremental write path calls
 * `deltaFor` with the one signal it just observed; the recompute pass calls
 * `composite` with every signal for a window. Because both land here, a ladder
 * rebuilt from source tables lands on the same number the live increments
 * produced — which is the entire premise of the lambda model. Any second
 * implementation of this arithmetic would reintroduce the drift it removes.
 *
 * INVARIANT: this shared arithmetic must never round. A ZSET score is an
 * IEEE-754 double and holds fractional weights (e.g. 0.01, 0.05, 0.5) natively.
 * Rounding once per `deltaFor` call would make many small increments diverge
 * from one large `composite` call over the same summed metrics — exactly the
 * incremental/recompute drift this engine exists to prevent. Rounding belongs
 * only where an integer is genuinely required, which is the snapshot
 * persistence path converting a score to a `BigInt` for PostgreSQL — not here.
 */
@Injectable()
export class VideoRoomRankingScoreEngine {
  private readonly config: VideoRoomRankingConfig;

  constructor(config: ConfigService) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  /** Absent metrics count as zero, never NaN — a NaN poisons the whole ladder. */
  private n(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  composite(dimension: VideoRoomRankingDimension, metrics: RankingMetrics): number {
    const w = this.config.weights;

    switch (dimension) {
      case VideoRoomRankingDimension.HOSTS:
        return this.normalize(
          this.n(metrics.coins) * w.host.coins +
            this.n(metrics.gifts) * w.host.gifts +
            this.n(metrics.watchSeconds) * w.host.watchSeconds +
            this.n(metrics.peakViewers) * w.host.peakViewers +
            this.n(metrics.pkWins) * w.host.pkWin +
            this.n(metrics.treasureEvents) * w.host.treasureEvent,
        );

      case VideoRoomRankingDimension.ROOMS:
        return this.normalize(
          this.n(metrics.giftCoins) * w.rooms.giftCoins +
            this.n(metrics.peakViewers) * w.rooms.peakViewers +
            this.n(metrics.avgWatchSeconds) * w.rooms.avgWatchSeconds +
            this.n(metrics.pkCount) * w.rooms.pkCount +
            this.n(metrics.treasureCount) * w.rooms.treasureCount,
        );

      case VideoRoomRankingDimension.PK:
        return this.normalize(
          this.n(metrics.wins) * w.pk.win +
            this.n(metrics.losses) * w.pk.loss +
            this.n(metrics.score) * w.pk.score +
            this.n(metrics.giftCoins) * w.pk.giftCoins,
        );

      case VideoRoomRankingDimension.GIFTERS:
        return this.normalize(this.n(metrics.coinsSpent));

      case VideoRoomRankingDimension.RECEIVERS:
        return this.normalize(this.n(metrics.coinsReceived));

      case VideoRoomRankingDimension.TREASURE:
        return this.normalize(this.n(metrics.treasureCoins));

      case VideoRoomRankingDimension.VIP: {
        // Level is the ranking; spend only orders users within a level. The
        // stride guarantees that, so a whale at VIP 4 can never outrank a
        // VIP 5 no matter how much they spend — but only if the tiebreak term
        // is clamped below one stride. Lifetime coin totals are stored as
        // BigInt precisely because they can exceed safe-integer bounds, so an
        // unclamped coinsSpent >= VIP_LEVEL_STRIDE would let a lower-level
        // whale tie or beat the level above them. The clamp is what makes
        // "a higher level always outranks any spend at a lower level" a total
        // invariant rather than one that merely holds for plausible inputs.
        const clampedSpend = Math.min(this.n(metrics.coinsSpent), VIP_LEVEL_STRIDE - 1);
        return this.normalize(this.n(metrics.vipOrdinal) * VIP_LEVEL_STRIDE + clampedSpend);
      }
    }
  }

  /**
   * The increment for one observed signal. Identical to `composite` by
   * construction — a ZSET score is additive, so "the delta for these metrics"
   * and "the score of these metrics" are the same arithmetic. Kept as a named
   * method so call sites read as intent rather than coincidence.
   */
  deltaFor(dimension: VideoRoomRankingDimension, metrics: RankingMetrics): number {
    return this.composite(dimension, metrics);
  }

  /**
   * Passes the value through unchanged except for one thing: `+ 0` turns a
   * negative zero into a positive zero, so a ZSET member never carries a -0.
   *
   * Deliberately does NOT round. This helper sits underneath both `composite`
   * and (via `deltaFor`) the incremental write path, and several weights are
   * fractional (e.g. host.watchSeconds = 0.01, pk.giftCoins = 0.5). Rounding
   * here would apply per call rather than per window, so many small increments
   * would no longer sum to the same total as one large recompute over the
   * equivalent summed metrics — the exact drift the recompute pass exists to
   * eliminate. Integer conversion, where required, happens downstream at the
   * snapshot persistence boundary (`BigInt(Math.round(entry.score))`), not here.
   */
  private normalize(value: number): number {
    return value + 0;
  }
}
