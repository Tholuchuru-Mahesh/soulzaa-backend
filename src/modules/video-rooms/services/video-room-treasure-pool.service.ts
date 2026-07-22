import { Injectable } from '@nestjs/common';
import { TreasurePoolStrategy } from '../constants/video-room-treasure.constants';
import { RewardPoolException } from '../exceptions/video-room-treasure.exceptions';

/** One level's frozen rules, as stored in `VideoRoomTreasureSession.levelSnapshot`. */
export interface TreasureLevelRules {
  level: number;
  threshold: number;
  poolStrategy: string;
  poolPercentBps: number;
  poolFixedAmount: number | null;
  winnerAlgorithm: string;
  winnerCount: number;
  minStaySeconds: number;
  minActivityEvents: number;
}

export interface PoolAllocation {
  userId: string;
  amount: bigint;
  shareBps: number;
}

export interface ComputedPool {
  strategy: string;
  sourceAmount: bigint;
  poolAmount: bigint;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * Computes and splits the reward pool (VR-11 spec §6.5).
 *
 * Pure arithmetic with no I/O — which is what lets the unlock pipeline compute
 * the pool before opening its transaction, and lets this be exhaustively tested
 * without a database.
 *
 * The pool is MINTED by the platform, not taken from contributed coins: video
 * progress is a counter, never an escrow (spec D1), so nothing here debits
 * anyone. `sourceAmount` records only what the pool was derived from, for audit.
 */
@Injectable()
export class VideoRoomTreasurePoolService {
  compute(rules: TreasureLevelRules): ComputedPool {
    const sourceAmount = BigInt(rules.threshold);

    switch (rules.poolStrategy) {
      case TreasurePoolStrategy.PERCENTAGE: {
        const bps = rules.poolPercentBps;
        if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
          throw new RewardPoolException(
            `Level ${rules.level} pool bps must be an integer in 0..10000, got ${bps}.`,
          );
        }
        return {
          strategy: rules.poolStrategy,
          sourceAmount,
          // Integer division floors: never mint a fraction of a coin.
          poolAmount: (sourceAmount * BigInt(bps)) / BPS_DENOMINATOR,
        };
      }

      case TreasurePoolStrategy.FIXED:
      case TreasurePoolStrategy.ADMIN_OVERRIDE: {
        const fixed = rules.poolFixedAmount;
        if (fixed === null || fixed === undefined || fixed < 0) {
          throw new RewardPoolException(
            `Level ${rules.level} uses ${rules.poolStrategy} but has no poolFixedAmount.`,
          );
        }
        return { strategy: rules.poolStrategy, sourceAmount, poolAmount: BigInt(fixed) };
      }

      default:
        throw new RewardPoolException(
          `Unknown pool strategy "${rules.poolStrategy}" on level ${rules.level}.`,
        );
    }
  }

  /**
   * Splits the pool evenly across the winners actually drawn — which may be
   * fewer than configured, or none at all when the room emptied before the
   * unlock.
   *
   * Integer division leaves dust (at most winners-1 coins). It is deliberately
   * NOT minted and not handed to an arbitrary winner: the pool row records
   * `poolAmount` and `allocatedAmount`, so the difference stays auditable
   * rather than hidden in someone's balance.
   */
  allocate(poolAmount: bigint, winnerIds: string[]): PoolAllocation[] {
    if (winnerIds.length === 0) return [];
    const each = poolAmount / BigInt(winnerIds.length);
    const shareBps = Math.floor(10_000 / winnerIds.length);
    return winnerIds.map((userId) => ({ userId, amount: each, shareBps }));
  }
}
