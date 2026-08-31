import { currentIsoWeekKeyUtc, shiftIsoWeekKey } from 'src/common/utils/iso-week.util';
import type { WeeklyContributionRepository } from '../repositories/weekly-contribution.repository';
import { WeeklyContributionService } from './weekly-contribution.service';

describe('WeeklyContributionService', () => {
  let repo: jest.Mocked<
    Pick<
      WeeklyContributionRepository,
      | 'currentWeekKey'
      | 'getWeekBucket'
      | 'listWeekBuckets'
      | 'weekLeaderboard'
      | 'monthHistory'
      | 'firstGiftAt'
    >
  >;
  let service: WeeklyContributionService;

  const bucket = (weekKey: string, amount: number) => ({
    weekKey,
    weekStart: `${weekKey}-start`,
    weekEnd: `${weekKey}-end`,
    amount,
  });

  beforeEach(() => {
    repo = {
      currentWeekKey: jest.fn(() => currentIsoWeekKeyUtc()),
      getWeekBucket: jest.fn(),
      listWeekBuckets: jest.fn(),
      weekLeaderboard: jest.fn(),
      monthHistory: jest.fn(),
      firstGiftAt: jest.fn().mockResolvedValue(null),
    } as never;
    service = new WeeklyContributionService(repo as unknown as WeeklyContributionRepository);
  });

  describe('weekly', () => {
    it('returns current + previous week and a delta %', async () => {
      const cur = currentIsoWeekKeyUtc();
      const prev = shiftIsoWeekKey(cur, -1);
      repo.getWeekBucket.mockImplementation(async (_s, _id, wk) =>
        bucket(wk, wk === cur ? 1500 : 1000),
      );

      const res = await service.weekly({ scope: 'room', id: 'r1' });
      expect(res.current.weekKey).toBe(cur);
      expect(res.previous.weekKey).toBe(prev);
      expect(res.current.amount).toBe(1500);
      expect(res.deltaPct).toBe(50); // +50%
    });

    it('deltaPct is null when the previous week was 0', async () => {
      repo.getWeekBucket.mockImplementation(async (_s, _id, wk) =>
        bucket(wk, wk === currentIsoWeekKeyUtc() ? 500 : 0),
      );
      const res = await service.weekly({ scope: 'user', id: 'u1' });
      expect(res.deltaPct).toBeNull();
    });

    it('honours an explicit valid weekKey and ignores a malformed one', async () => {
      repo.getWeekBucket.mockImplementation(async (_s, _id, wk) => bucket(wk, 10));
      const a = await service.weekly({ scope: 'room', id: 'r1', weekKey: '2026W10' });
      expect(a.current.weekKey).toBe('2026W10');

      const b = await service.weekly({ scope: 'room', id: 'r1', weekKey: 'not-a-key' as never });
      expect(b.current.weekKey).toBe(currentIsoWeekKeyUtc());
    });
  });

  describe('history', () => {
    it('week granularity lists buckets newest-first, paginated', async () => {
      repo.listWeekBuckets.mockResolvedValue([
        bucket('2026W30', 1),
        bucket('2026W31', 2),
        bucket('2026W32', 3),
      ]);
      const res = await service.history({
        scope: 'room',
        id: 'r1',
        granularity: 'week',
        page: 1,
        limit: 2,
        skip: 0,
      } as never);
      expect((res.items as { weekKey: string }[]).map((i) => i.weekKey)).toEqual([
        '2026W32',
        '2026W31',
      ]);
      expect(res.total).toBe(3);
    });

    it('month granularity rolls up straight from the ledger', async () => {
      repo.monthHistory.mockResolvedValue([
        { monthKey: '2026-01', amount: 100 },
        { monthKey: '2026-02', amount: 200 },
      ]);
      const res = await service.history({
        scope: 'user',
        id: 'u1',
        granularity: 'month',
        page: 1,
        limit: 12,
        skip: 0,
      } as never);
      expect((res.items as { monthKey: string }[]).map((i) => i.monthKey)).toEqual([
        '2026-02',
        '2026-01',
      ]);
      expect(repo.monthHistory).toHaveBeenCalled();
      expect(repo.listWeekBuckets).not.toHaveBeenCalled();
    });
  });

  describe('leaderboard', () => {
    it('returns the week window + rows', async () => {
      repo.weekLeaderboard.mockResolvedValue([
        { id: 'r1', amount: 900 },
        { id: 'r2', amount: 400 },
      ]);
      const res = await service.leaderboard({ scope: 'room', weekKey: '2026W36', limit: 20 });
      expect(res.weekKey).toBe('2026W36');
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0].amount).toBe(900);
    });
  });
});
