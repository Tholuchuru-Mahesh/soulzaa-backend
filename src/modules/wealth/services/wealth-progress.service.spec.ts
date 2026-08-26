import { currentPeriodKey, previousPeriodKey } from '../constants/wealth.constants';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthLevelService } from './wealth-level.service';
import { WealthProgressService } from './wealth-progress.service';

const NOW_PERIOD = currentPeriodKey();
const OLD_PERIOD = previousPeriodKey(NOW_PERIOD);

describe('WealthProgressService', () => {
  let repo: Record<string, jest.Mock>;
  let levels: Record<string, jest.Mock>;
  let service: WealthProgressService;

  beforeEach(() => {
    repo = { getProgress: jest.fn().mockResolvedValue(null) };
    levels = {
      getByOrdinal: jest.fn((level: number) =>
        level === 3 ? { level: 3, name: 'Nova', expThreshold: 75_000n } : level === 4 ? { level: 4, name: 'Elite', expThreshold: 150_000n } : null,
      ),
      nextLevel: jest.fn((level: number) =>
        level === 3 ? { level: 4, name: 'Elite', expThreshold: 150_000n } : null,
      ),
    };
    service = new WealthProgressService(
      repo as unknown as WealthRepository,
      levels as unknown as WealthLevelService,
    );
  });

  describe('getEffectiveLevel — the cross-module gate contract', () => {
    it('returns 0 for a user with no progress row (never purchased)', async () => {
      expect(await service.getEffectiveLevel('u1')).toBe(0);
    });

    it("returns the current month's effective level", async () => {
      repo.getProgress.mockResolvedValue({ currentExp: 100_000n, currentLevel: 3, periodKey: NOW_PERIOD });
      expect(await service.getEffectiveLevel('u1')).toBe(3);
    });
  });

  describe('getStatus', () => {
    it("returns Normal User / 0 EXP for a user who never purchased — not an error", async () => {
      const status = await service.getStatus('u1');

      expect(status.level).toBe(0);
      expect(status.currentExp).toBe(0);
      expect(status.levelName).toBe('Normal User');
    });

    it('computes next level, required EXP, remaining EXP and progress percentage', async () => {
      repo.getProgress.mockResolvedValue({ currentExp: 100_000n, currentLevel: 3, periodKey: NOW_PERIOD });

      const status = await service.getStatus('u1');

      expect(status).toMatchObject({
        level: 3,
        levelName: 'Nova',
        currentExp: 100_000,
        nextLevel: 4,
        nextLevelName: 'Elite',
        nextLevelExp: 150_000,
        remainingExp: 50_000,
      });
      // (100,000 - 75,000) / (150,000 - 75,000) = 33.33%
      expect(status.progressPct).toBeCloseTo(33.33, 1);
    });

    it('reports 100% progress and no next level at the max level', async () => {
      levels.getByOrdinal.mockReturnValue({ level: 12, name: 'Immortal', expThreshold: 40_000_000n });
      levels.nextLevel.mockReturnValue(null);
      repo.getProgress.mockResolvedValue({ currentExp: 45_000_000n, currentLevel: 12, periodKey: NOW_PERIOD });

      const status = await service.getStatus('u1');

      expect(status.nextLevel).toBeNull();
      expect(status.remainingExp).toBeNull();
      expect(status.progressPct).toBe(100);
    });

    it("does not report a stale previous month's EXP, only the carried-over effective level", async () => {
      repo.getProgress.mockResolvedValue({ currentExp: 5_000_000n, currentLevel: 3, periodKey: OLD_PERIOD });

      const status = await service.getStatus('u1');

      expect(status.currentExp).toBe(0);
      expect(status.level).toBe(3);
      expect(status.periodKey).toBe(NOW_PERIOD);
    });
  });
});
