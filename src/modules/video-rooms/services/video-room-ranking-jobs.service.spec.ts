import { RankingPeriodResolver } from 'src/modules/rankings/interfaces';
import {
  VIDEO_ROOM_RANKING_JOBS,
  VideoRoomRankingDimension,
} from '../constants/video-room-ranking.constants';
import { VideoRoomRankingJobsService } from './video-room-ranking-jobs.service';

describe('VideoRoomRankingJobsService', () => {
  let registered: Record<string, (data: unknown) => Promise<unknown>>;
  let registry: { register: jest.Mock };
  let locks: { acquire: jest.Mock };
  let aggregation: { recomputeAll: jest.Mock; derivePeriod: jest.Mock };
  let snapshots: { snapshotAll: jest.Mock; pruneExpired: jest.Mock };
  let service: VideoRoomRankingJobsService;

  beforeEach(() => {
    registered = {};
    registry = {
      register: jest.fn((_q: string, name: string, h: (d: unknown) => Promise<unknown>) => {
        registered[name] = h;
      }),
    };
    // `acquire` resolves to a release fn when the lock is taken, or null when
    // it is held elsewhere. It never throws and never retries — see the note in
    // the implementation step on why withLock is deliberately NOT used here.
    locks = { acquire: jest.fn().mockResolvedValue(jest.fn().mockResolvedValue(undefined)) };
    aggregation = {
      recomputeAll: jest.fn().mockResolvedValue([{ status: 'RECOMPUTED', entriesWritten: 3 }]),
      derivePeriod: jest.fn().mockResolvedValue(4),
    };
    snapshots = {
      snapshotAll: jest.fn().mockResolvedValue(12),
      pruneExpired: jest.fn().mockResolvedValue({ hourly: 5 }),
    };
    service = new VideoRoomRankingJobsService(
      registry as never,
      locks as never,
      aggregation as never,
      snapshots as never,
    );
    service.onModuleInit();
  });

  it('registers all seven jobs on the ranking-processing queue', () => {
    expect(Object.keys(registered).sort()).toEqual(Object.values(VIDEO_ROOM_RANKING_JOBS).sort());
    expect(registry.register.mock.calls.every((c) => c[0] === 'ranking-processing')).toBe(true);
  });

  describe('aggregate jobs', () => {
    it('takes a fleet-wide lock before doing work', async () => {
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' });
      expect(locks.acquire).toHaveBeenCalledWith(
        expect.stringContaining('vrank:agg:lock:'),
        expect.any(Number),
      );
    });

    it('releases the lock even when the recompute throws', async () => {
      const release = jest.fn().mockResolvedValue(undefined);
      locks.acquire.mockResolvedValue(release);
      aggregation.recomputeAll.mockRejectedValue(new Error('db down'));
      await expect(
        registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' }),
      ).rejects.toThrow();
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('uses a distinct lock key per window — not a constant collapsed across dateKeys', async () => {
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' });
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260723' });

      const keys = locks.acquire.mock.calls.map((call) => call[0]);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
    });

    it('recomputes then snapshots for a daily window', async () => {
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' });
      expect(aggregation.recomputeAll).toHaveBeenCalledWith('daily', '20260722');
      expect(snapshots.snapshotAll).toHaveBeenCalledWith('daily', '20260722');
    });

    // Fixed system time (via fake timers) so the SUT's `Date.now()` and this
    // test's expectation are computed against the exact same instant — a real
    // `Date.now()` call in the assertion could tick past a period boundary
    // (midnight, the top of the hour, ...) and flake.
    describe('defaults to the PREVIOUS window when no dateKey is supplied', () => {
      const periods = new RankingPeriodResolver();

      afterEach(() => {
        jest.useRealTimers();
      });

      it('daily: recomputes with EXACTLY the previous-day key, not just a past-looking one', async () => {
        // A cron firing at 00:10 must close YESTERDAY, not the day just begun.
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-22T00:10:00.000Z'));
        const expected = periods.dateKeyFor('daily', new Date(Date.now() - 86_400_000));

        await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({});

        expect(aggregation.recomputeAll).toHaveBeenCalledWith('daily', expected);
      });

      it('hourly: recomputes with EXACTLY the previous-hour key', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-22T05:02:00.000Z'));
        const expected = periods.dateKeyFor('hourly', new Date(Date.now() - 3_600_000));

        await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_HOURLY]({});

        expect(aggregation.recomputeAll).toHaveBeenCalledWith('hourly', expected);
      });

      it('weekly: recomputes with EXACTLY the previous-week key', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-22T00:20:00.000Z'));
        const expected = periods.dateKeyFor('weekly', new Date(Date.now() - 7 * 86_400_000));

        await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_WEEKLY]({});

        expect(aggregation.recomputeAll).toHaveBeenCalledWith('weekly', expected);
      });
    });

    it('does not snapshot an hourly window — too many rows, too little value', async () => {
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_HOURLY]({ dateKey: '2026072213' });
      expect(aggregation.recomputeAll).toHaveBeenCalledWith('hourly', '2026072213');
      expect(snapshots.snapshotAll).not.toHaveBeenCalled();
    });

    it('derives the quarter for EVERY dimension after a monthly close, including hosts/rooms', async () => {
      // `derivePeriod` is a pure Redis union that must run for all seven
      // dimensions even though `hosts`/`rooms` are excluded from the
      // source-table RECOMPUTE — a regression that derives only one
      // dimension, or collapses the loop, must fail this test.
      await registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_MONTHLY]({ dateKey: '202607' });

      const expectedDimensions = Object.values(VideoRoomRankingDimension);
      expect(aggregation.derivePeriod).toHaveBeenCalledTimes(expectedDimensions.length);

      const calledDimensions = aggregation.derivePeriod.mock.calls.map((call) => call[0]);
      expect(new Set(calledDimensions)).toEqual(new Set(expectedDimensions));

      for (const call of aggregation.derivePeriod.mock.calls) {
        expect(call[1]).toBe('quarterly');
        expect(call[2]).toBe('2026Q3');
      }
    });

    it('returns quietly when the lock is held elsewhere, without retrying', async () => {
      locks.acquire.mockResolvedValue(null);
      await expect(
        registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' }),
      ).resolves.toEqual({ skipped: 'locked' });
      expect(aggregation.recomputeAll).not.toHaveBeenCalled();
      expect(locks.acquire).toHaveBeenCalledTimes(1);
    });

    it('propagates a real failure so BullMQ retries and eventually dead-letters', async () => {
      aggregation.recomputeAll.mockRejectedValue(new Error('db down'));
      await expect(
        registered[VIDEO_ROOM_RANKING_JOBS.AGGREGATE_DAILY]({ dateKey: '20260722' }),
      ).rejects.toThrow('db down');
    });
  });

  describe('cleanup', () => {
    it('prunes expired snapshots', async () => {
      await expect(registered[VIDEO_ROOM_RANKING_JOBS.CLEANUP]({})).resolves.toEqual({
        pruned: { hourly: 5 },
      });
    });
  });
});
