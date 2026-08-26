import { WealthExpSourceType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { currentPeriodKey, previousPeriodKey } from '../constants/wealth.constants';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthExpLedgerService } from './wealth-exp-ledger.service';
import { WealthLevelService } from './wealth-level.service';
import { WealthRewardService } from './wealth-reward.service';

const NOW_PERIOD = currentPeriodKey();
const OLD_PERIOD = previousPeriodKey(NOW_PERIOD);

describe('WealthExpLedgerService', () => {
  let repo: Record<string, jest.Mock>;
  let levels: Record<string, jest.Mock>;
  let rewards: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let service: WealthExpLedgerService;

  beforeEach(() => {
    repo = {
      findLedgerByIdempotencyKey: jest.fn().mockResolvedValue(null),
      getProgress: jest.fn().mockResolvedValue(null),
      applyAward: jest.fn().mockResolvedValue(undefined),
      netAwardedForSourceRef: jest.fn().mockResolvedValue(0n),
      applyReversal: jest.fn().mockResolvedValue(undefined),
    };
    // Mirrors the real threshold table's ordinals for the levels exercised here.
    levels = {
      levelForExp: jest.fn((exp: bigint) => {
        if (exp >= 150_000n) return 4;
        if (exp >= 75_000n) return 3;
        if (exp >= 30_000n) return 2;
        if (exp >= 10_000n) return 1;
        return 0;
      }),
    };
    rewards = { grantAutomaticForCrossedLevels: jest.fn().mockResolvedValue(undefined) };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new WealthExpLedgerService(
      repo as unknown as WealthRepository,
      levels as unknown as WealthLevelService,
      rewards as unknown as WealthRewardService,
      locks as unknown as LockService,
      bus,
    );
  });

  describe('award', () => {
    it('rejects a non-positive or non-integer amount', async () => {
      await expect(
        service.award({ userId: 'u1', amount: 0, sourceRef: 'o1', idempotencyKey: 'k1' }),
      ).rejects.toThrow();
      await expect(
        service.award({ userId: 'u1', amount: 1.5, sourceRef: 'o1', idempotencyKey: 'k2' }),
      ).rejects.toThrow();
      expect(repo.applyAward).not.toHaveBeenCalled();
    });

    it('10,000 paid + 0 bonus = 10,000 EXP crosses into Prestige (level 1)', async () => {
      const res = await service.award({
        userId: 'u1',
        amount: 10_000,
        sourceRef: 'order-1',
        idempotencyKey: 'wealth-exp:tx-1',
      });

      expect(res).toEqual({ currentExp: 10_000, currentLevel: 1, leveledUp: true });
      expect(repo.applyAward).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          amount: 10_000n,
          sourceType: WealthExpSourceType.GOLD_COIN_PURCHASE,
          sourceRef: 'order-1',
          idempotencyKey: 'wealth-exp:tx-1',
          newLevel: 1,
        }),
      );
    });

    it('10,000 paid + 2,000 bonus = 12,000 EXP (the full combined credit, not just the paid portion)', async () => {
      const res = await service.award({
        userId: 'u1',
        amount: 12_000,
        sourceRef: 'order-2',
        idempotencyKey: 'wealth-exp:tx-2',
      });

      expect(res.currentExp).toBe(12_000);
      expect(repo.applyAward).toHaveBeenCalledWith(expect.objectContaining({ amount: 12_000n }));
    });

    it('publishes a level-up event and grants crossed-level rewards only when the level actually increases', async () => {
      repo.getProgress.mockResolvedValue({
        currentExp: 8_000n,
        currentLevel: 0,
        periodKey: NOW_PERIOD,
      });

      const res = await service.award({
        userId: 'u1',
        amount: 5_000,
        sourceRef: 'order-3',
        idempotencyKey: 'wealth-exp:tx-3',
      });

      // 8,000 + 5,000 = 13,000 → level 1
      expect(res).toEqual({ currentExp: 13_000, currentLevel: 1, leveledUp: true });
      expect(rewards.grantAutomaticForCrossedLevels).toHaveBeenCalledWith('u1', 0, 1, NOW_PERIOD);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'wealth.level_up',
          payload: expect.objectContaining({ userId: 'u1', fromLevel: 0, toLevel: 1 }),
        }),
      );
    });

    it('does not publish or grant rewards when EXP increases but the level does not', async () => {
      repo.getProgress.mockResolvedValue({
        currentExp: 10_000n,
        currentLevel: 1,
        periodKey: NOW_PERIOD,
      });

      const res = await service.award({
        userId: 'u1',
        amount: 100,
        sourceRef: 'order-4',
        idempotencyKey: 'wealth-exp:tx-4',
      });

      expect(res.leveledUp).toBe(false);
      expect(rewards.grantAutomaticForCrossedLevels).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('is idempotent — a replayed award (duplicate webhook/retry) does not re-apply', async () => {
      repo.findLedgerByIdempotencyKey.mockResolvedValue({ id: 'ledger-1' });
      repo.getProgress.mockResolvedValue({
        currentExp: 10_000n,
        currentLevel: 1,
        periodKey: NOW_PERIOD,
      });

      const res = await service.award({
        userId: 'u1',
        amount: 10_000,
        sourceRef: 'order-1',
        idempotencyKey: 'wealth-exp:tx-1',
      });

      expect(res).toEqual({ currentExp: 10_000, currentLevel: 1, leveledUp: false });
      expect(repo.applyAward).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('never decreases the effective level below the current downgrade-adjusted floor within the same award', async () => {
      // Floor from a downgrade is already baked into currentLevel; a small
      // purchase that alone wouldn't reach that level must not regress it.
      repo.getProgress.mockResolvedValue({
        currentExp: 0n,
        currentLevel: 3, // downgrade floor for this month
        periodKey: NOW_PERIOD,
      });

      const res = await service.award({
        userId: 'u1',
        amount: 100, // far below the level-3 threshold on its own
        sourceRef: 'order-5',
        idempotencyKey: 'wealth-exp:tx-5',
      });

      expect(res.currentLevel).toBe(3);
      expect(res.leveledUp).toBe(false);
    });

    it('treats a stale progress row (still on a previous period) as starting from 0 EXP this month', async () => {
      repo.getProgress.mockResolvedValue({
        currentExp: 5_000_000n,
        currentLevel: 9,
        periodKey: OLD_PERIOD,
      });

      const res = await service.award({
        userId: 'u1',
        amount: 10_000,
        sourceRef: 'order-6',
        idempotencyKey: 'wealth-exp:tx-6',
      });

      // Old month's 5,000,000 EXP must not be carried forward; only the
      // downgrade-preserved effective level (9) acts as the floor.
      expect(res.currentExp).toBe(10_000);
      expect(res.currentLevel).toBe(9);
    });
  });

  describe('reverse', () => {
    it('rejects a non-positive amount', async () => {
      await expect(
        service.reverse({ userId: 'u1', sourceRef: 'order-1', amount: 0, idempotencyKey: 'r1' }),
      ).rejects.toThrow();
    });

    it('is idempotent — a replayed reversal is a no-op', async () => {
      repo.findLedgerByIdempotencyKey.mockResolvedValue({ id: 'ledger-2' });

      await service.reverse({
        userId: 'u1',
        sourceRef: 'order-1',
        amount: 10_000,
        idempotencyKey: 'wealth-exp-reversal:tx-1',
      });

      expect(repo.applyReversal).not.toHaveBeenCalled();
    });

    it('reverses EXP and recomputes the level when the original award is still in the current month', async () => {
      repo.netAwardedForSourceRef.mockResolvedValue(10_000n);
      repo.getProgress.mockResolvedValue({
        currentExp: 12_000n,
        currentLevel: 1,
        periodKey: NOW_PERIOD,
      });

      await service.reverse({
        userId: 'u1',
        sourceRef: 'order-1',
        amount: 10_000,
        idempotencyKey: 'wealth-exp-reversal:tx-1',
      });

      expect(repo.applyReversal).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 10_000n,
          newExp: 2_000n,
          newLevel: 0,
        }),
      );
    });

    it('never reverses more than what remains outstanding for the purchase', async () => {
      // Only 4,000 EXP is still outstanding (e.g. a partial prior reversal already happened).
      repo.netAwardedForSourceRef.mockResolvedValue(4_000n);
      repo.getProgress.mockResolvedValue({
        currentExp: 4_000n,
        currentLevel: 0,
        periodKey: NOW_PERIOD,
      });

      await service.reverse({
        userId: 'u1',
        sourceRef: 'order-1',
        amount: 10_000,
        idempotencyKey: 'wealth-exp-reversal:tx-2',
      });

      expect(repo.applyReversal).toHaveBeenCalledWith(expect.objectContaining({ amount: 4_000n }));
    });

    it('never lets reversed EXP go negative', async () => {
      repo.netAwardedForSourceRef.mockResolvedValue(10_000n);
      repo.getProgress.mockResolvedValue({
        currentExp: 3_000n, // already spent down / partially reset somehow
        currentLevel: 0,
        periodKey: NOW_PERIOD,
      });

      await service.reverse({
        userId: 'u1',
        sourceRef: 'order-1',
        amount: 10_000,
        idempotencyKey: 'wealth-exp-reversal:tx-3',
      });

      expect(repo.applyReversal).toHaveBeenCalledWith(expect.objectContaining({ newExp: 0n, newLevel: 0 }));
    });

    it('does not mutate live progress for a purchase whose awarding month has already closed — history stays immutable', async () => {
      repo.netAwardedForSourceRef.mockResolvedValue(10_000n);
      repo.getProgress.mockResolvedValue({
        currentExp: 500n,
        currentLevel: 0,
        periodKey: OLD_PERIOD,
      });

      await service.reverse({
        userId: 'u1',
        sourceRef: 'order-1',
        amount: 10_000,
        idempotencyKey: 'wealth-exp-reversal:tx-4',
      });

      expect(repo.applyReversal).toHaveBeenCalledWith(
        expect.objectContaining({ newExp: null, newLevel: null }),
      );
    });
  });
});
