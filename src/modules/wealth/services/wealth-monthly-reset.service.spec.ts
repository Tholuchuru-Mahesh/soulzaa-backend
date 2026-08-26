import type { IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { currentPeriodKey, previousPeriodKey } from '../constants/wealth.constants';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthDowngradeConfigService } from './wealth-downgrade-config.service';
import { WealthMonthlyResetService } from './wealth-monthly-reset.service';
import { WealthRewardService } from './wealth-reward.service';

const NEW_PERIOD = currentPeriodKey();
const CLOSING_PERIOD = previousPeriodKey(NEW_PERIOD);

describe('WealthMonthlyResetService', () => {
  let repo: Record<string, jest.Mock>;
  let downgradeConfig: Record<string, jest.Mock>;
  let rewards: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let service: WealthMonthlyResetService;

  beforeEach(() => {
    repo = {
      getResetRun: jest.fn().mockResolvedValue(null),
      tryStartResetRun: jest.fn().mockResolvedValue({ id: 'run-1', periodKey: NEW_PERIOD }),
      restartFailedRun: jest.fn().mockResolvedValue(undefined),
      completeResetRun: jest.fn().mockResolvedValue(undefined),
      failResetRun: jest.fn().mockResolvedValue(undefined),
      listAllProgressUserIds: jest.fn().mockResolvedValue([]),
      getMonthlyHistory: jest.fn().mockResolvedValue(null),
      getProgress: jest.fn().mockResolvedValue(null),
      createMonthlyHistory: jest.fn().mockResolvedValue(undefined),
      resetProgressForNewMonth: jest.fn().mockResolvedValue(undefined),
    };
    downgradeConfig = {
      getActive: jest.fn().mockResolvedValue({ enabled: true, maxDowngradeLevels: 1, minLevel: 0 }),
    };
    rewards = { grantAutomaticForPeriod: jest.fn().mockResolvedValue(undefined) };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new WealthMonthlyResetService(
      repo as unknown as WealthRepository,
      downgradeConfig as unknown as WealthDowngradeConfigService,
      rewards as unknown as WealthRewardService,
      locks as unknown as LockService,
      bus,
    );
  });

  describe('downgrade floor math', () => {
    it('drops by exactly maxDowngradeLevels, floored at minLevel', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);
      repo.getProgress.mockResolvedValue({
        currentExp: 0n,
        currentLevel: 5,
        periodKey: CLOSING_PERIOD,
      });
      downgradeConfig.getActive.mockResolvedValue({ enabled: true, maxDowngradeLevels: 2, minLevel: 0 });

      await service.run(new Date());

      expect(repo.resetProgressForNewMonth).toHaveBeenCalledWith({
        userId: 'u1',
        newPeriodKey: NEW_PERIOD,
        floorLevel: 3, // 5 - 2
      });
    });

    it('never drops below the configured minLevel', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);
      repo.getProgress.mockResolvedValue({
        currentExp: 0n,
        currentLevel: 2,
        periodKey: CLOSING_PERIOD,
      });
      downgradeConfig.getActive.mockResolvedValue({ enabled: true, maxDowngradeLevels: 5, minLevel: 1 });

      await service.run(new Date());

      expect(repo.resetProgressForNewMonth).toHaveBeenCalledWith(
        expect.objectContaining({ floorLevel: 1 }),
      );
    });

    it('never downgrades at all when disabled, regardless of maxDowngradeLevels', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);
      repo.getProgress.mockResolvedValue({
        currentExp: 0n,
        currentLevel: 6,
        periodKey: CLOSING_PERIOD,
      });
      downgradeConfig.getActive.mockResolvedValue({ enabled: false, maxDowngradeLevels: 3, minLevel: 0 });

      await service.run(new Date());

      expect(repo.resetProgressForNewMonth).toHaveBeenCalledWith(
        expect.objectContaining({ floorLevel: 6 }),
      );
    });

    it('rolls the live progress row over to the new period key', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);
      repo.getProgress.mockResolvedValue({
        currentExp: 999_999n,
        currentLevel: 4,
        periodKey: CLOSING_PERIOD,
      });

      await service.run(new Date());

      expect(repo.resetProgressForNewMonth).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', newPeriodKey: NEW_PERIOD }),
      );
    });

    it('publishes a downgrade event only when the floor is actually below the starting level', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1', 'u2']);
      repo.getProgress
        .mockResolvedValueOnce({ currentExp: 0n, currentLevel: 5, periodKey: CLOSING_PERIOD })
        .mockResolvedValueOnce({ currentExp: 0n, currentLevel: 0, periodKey: CLOSING_PERIOD });

      await service.run(new Date());

      const downgradeEvents = bus.publish.mock.calls.filter(
        (c) => c[0].name === 'wealth.downgraded',
      );
      expect(downgradeEvents).toHaveLength(1);
      expect(downgradeEvents[0][0].payload).toMatchObject({ userId: 'u1', fromLevel: 5, toLevel: 4 });
    });

    it('records the monthly history snapshot with starting level, final EXP/level and the applied floor', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);
      repo.getProgress.mockResolvedValue({
        currentExp: 82_000n,
        currentLevel: 3,
        periodKey: CLOSING_PERIOD,
      });

      await service.run(new Date());

      expect(repo.createMonthlyHistory).toHaveBeenCalledWith({
        userId: 'u1',
        periodKey: CLOSING_PERIOD,
        startingLevel: 3,
        finalExp: 82_000n,
        finalLevel: 3,
        downgradedToLevel: 2,
      });
    });

    it('grants recurring automatic rewards for the new effective level', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);
      repo.getProgress.mockResolvedValue({ currentExp: 0n, currentLevel: 5, periodKey: CLOSING_PERIOD });

      await service.run(new Date());

      expect(rewards.grantAutomaticForPeriod).toHaveBeenCalledWith('u1', 4, NEW_PERIOD);
    });
  });

  describe('idempotency', () => {
    it('is a no-op batch-wide if a run for this period already COMPLETED', async () => {
      repo.getResetRun.mockResolvedValue({ periodKey: NEW_PERIOD, status: 'COMPLETED', usersProcessed: 3 });
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);

      const result = await service.run(new Date());

      expect(result.skipped).toBe(true);
      expect(repo.tryStartResetRun).not.toHaveBeenCalled();
      expect(repo.resetProgressForNewMonth).not.toHaveBeenCalled();
    });

    it('skips a user already recorded in monthly history for the closing period (per-user idempotency)', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);
      repo.getMonthlyHistory.mockResolvedValue({ userId: 'u1', periodKey: CLOSING_PERIOD });

      await service.run(new Date());

      expect(repo.resetProgressForNewMonth).not.toHaveBeenCalled();
      expect(repo.createMonthlyHistory).not.toHaveBeenCalled();
    });

    it('a second concurrent run that loses the create race is skipped, not double-processed', async () => {
      repo.tryStartResetRun.mockResolvedValue(null);
      repo.listAllProgressUserIds.mockResolvedValue(['u1']);

      const result = await service.run(new Date());

      expect(result.skipped).toBe(true);
      expect(repo.resetProgressForNewMonth).not.toHaveBeenCalled();
    });

    it('marks the run FAILED (not COMPLETED) if a user fails mid-batch, so a retry is possible', async () => {
      repo.listAllProgressUserIds.mockResolvedValue(['u1', 'u2']);
      repo.getProgress
        .mockResolvedValueOnce({ currentExp: 0n, currentLevel: 1, periodKey: CLOSING_PERIOD })
        .mockRejectedValueOnce(new Error('db blip'));

      // run() never rejects — a mid-batch failure is caught, the run is
      // marked FAILED for a later retry, and a skipped result is returned.
      const result = await service.run(new Date());

      expect(result.skipped).toBe(true);
      expect(repo.failResetRun).toHaveBeenCalledWith(NEW_PERIOD);
      expect(repo.completeResetRun).not.toHaveBeenCalled();
    });
  });
});
