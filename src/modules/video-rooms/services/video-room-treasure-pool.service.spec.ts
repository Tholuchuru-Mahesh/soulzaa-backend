import { RewardPoolException } from '../exceptions/video-room-treasure.exceptions';
import {
  VideoRoomTreasurePoolService,
  type TreasureLevelRules,
} from './video-room-treasure-pool.service';

const rules = (over: Partial<TreasureLevelRules> = {}): TreasureLevelRules => ({
  level: 1,
  threshold: 15_000,
  poolStrategy: 'PERCENTAGE',
  poolPercentBps: 1000,
  poolFixedAmount: null,
  winnerAlgorithm: 'RANDOM',
  winnerCount: 3,
  minStaySeconds: 120,
  minActivityEvents: 0,
  ...over,
});

describe('VideoRoomTreasurePoolService', () => {
  const service = new VideoRoomTreasurePoolService();

  describe('compute', () => {
    it('mints 10% of the threshold under PERCENTAGE', () => {
      expect(service.compute(rules())).toEqual({
        strategy: 'PERCENTAGE',
        sourceAmount: 15_000n,
        poolAmount: 1_500n,
      });
    });

    it('floors fractional bps rather than minting a fraction of a coin', () => {
      // 15001 * 333 / 10000 = 499.5333
      expect(service.compute(rules({ threshold: 15_001, poolPercentBps: 333 })).poolAmount).toBe(
        499n,
      );
    });

    it('mints nothing at 0 bps rather than failing', () => {
      expect(service.compute(rules({ poolPercentBps: 0 })).poolAmount).toBe(0n);
    });

    it('handles the whole threshold at 10000 bps', () => {
      expect(service.compute(rules({ poolPercentBps: 10_000 })).poolAmount).toBe(15_000n);
    });

    it('mints the fixed amount under FIXED and ADMIN_OVERRIDE', () => {
      for (const poolStrategy of ['FIXED', 'ADMIN_OVERRIDE']) {
        expect(service.compute(rules({ poolStrategy, poolFixedAmount: 2_500 })).poolAmount).toBe(
          2_500n,
        );
      }
    });

    it('rejects FIXED with no amount rather than silently minting zero', () => {
      expect(() =>
        service.compute(rules({ poolStrategy: 'FIXED', poolFixedAmount: null })),
      ).toThrow(RewardPoolException);
    });

    it('rejects an unknown strategy instead of falling back', () => {
      expect(() => service.compute(rules({ poolStrategy: 'LOTTERY' }))).toThrow(
        RewardPoolException,
      );
    });

    // A pool larger than its source is a config bug, not a generous operator.
    it('rejects bps outside 0..10000', () => {
      expect(() => service.compute(rules({ poolPercentBps: 10_001 }))).toThrow(RewardPoolException);
      expect(() => service.compute(rules({ poolPercentBps: -1 }))).toThrow(RewardPoolException);
      expect(() => service.compute(rules({ poolPercentBps: 12.5 }))).toThrow(RewardPoolException);
    });
  });

  describe('allocate', () => {
    it('splits the pool evenly and leaves the dust unminted', () => {
      const alloc = service.allocate(1_000n, ['u1', 'u2', 'u3']);
      expect(alloc.map((a) => a.amount)).toEqual([333n, 333n, 333n]);
      const total = alloc.reduce((s, a) => s + a.amount, 0n);
      // Dust is derivable as poolAmount - allocatedAmount, never hidden in a balance.
      expect(1_000n - total).toBe(1n);
    });

    it('gives the whole pool to a lone winner', () => {
      expect(service.allocate(1_500n, ['u1'])).toEqual([
        { userId: 'u1', amount: 1_500n, shareBps: 10_000 },
      ]);
    });

    it('divides evenly with no dust when the pool is divisible', () => {
      const alloc = service.allocate(1_500n, ['u1', 'u2', 'u3']);
      expect(alloc.map((a) => a.amount)).toEqual([500n, 500n, 500n]);
      expect(alloc.reduce((s, a) => s + a.amount, 0n)).toBe(1_500n);
    });

    // Zero eligible is a normal outcome (empty room at unlock), not an error.
    it('allocates nothing when there are no winners', () => {
      expect(service.allocate(1_500n, [])).toEqual([]);
    });

    it('allocates nothing when the pool is zero', () => {
      expect(service.allocate(0n, ['u1', 'u2']).map((a) => a.amount)).toEqual([0n, 0n]);
    });
  });
});
