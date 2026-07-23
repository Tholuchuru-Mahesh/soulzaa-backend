import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingRecoveryService } from './video-room-ranking-recovery.service';

describe('VideoRoomRankingRecoveryService', () => {
  const config = { get: () => ({}) } as never;
  let repo: any;
  let store: any;
  let aggregation: { recomputeAll: jest.Mock; recomputeDimension: jest.Mock };
  let service: VideoRoomRankingRecoveryService;

  beforeEach(() => {
    repo = {
      invalidateAggregation: jest.fn().mockResolvedValue(1),
      findLeaderboardSnapshot: jest.fn().mockResolvedValue({
        entries: [
          { targetId: 'u1', rank: 1, score: '900' },
          { targetId: 'u2', rank: 2, score: '400' },
        ],
      }),
    };
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      replace: jest.fn().mockResolvedValue(undefined),
      bumpVersion: jest.fn().mockResolvedValue(1),
    };
    aggregation = {
      recomputeAll: jest.fn().mockResolvedValue([{ status: 'RECOMPUTED' }]),
      recomputeDimension: jest.fn().mockResolvedValue({ status: 'RECOMPUTED' }),
    };
    service = new VideoRoomRankingRecoveryService(config, repo, store, aggregation as never);
  });

  describe('replay', () => {
    it('clears the SUCCEEDED guard first so the recompute actually re-runs', async () => {
      await service.replay('daily', '20260722');
      // Every dimension's log row must be invalidated before recomputeAll,
      // or beginAggregation returns ALREADY_SUCCEEDED and the replay no-ops.
      expect(repo.invalidateAggregation).toHaveBeenCalled();
      const invalidateOrder = repo.invalidateAggregation.mock.invocationCallOrder[0];
      const recomputeOrder = aggregation.recomputeAll.mock.invocationCallOrder[0];
      expect(invalidateOrder).toBeLessThan(recomputeOrder);
    });

    it('invalidates the guard for every RECOMPUTABLE dimension', async () => {
      await service.replay('daily', '20260722');
      // hosts and rooms are excluded from recompute (see
      // RECOMPUTE_EXCLUDED_DIMENSIONS) — 7 dimensions total, 2 excluded.
      expect(repo.invalidateAggregation).toHaveBeenCalledTimes(5);
    });

    it('does NOT invalidate the guard for hosts or rooms — recomputeAll never touches their log row', async () => {
      await service.replay('daily', '20260722');
      const dimensionsInvalidated = repo.invalidateAggregation.mock.calls.map(
        (c: [{ dimension: string }, string]) => c[0].dimension,
      );
      expect(dimensionsInvalidated).not.toContain(VideoRoomRankingDimension.HOSTS);
      expect(dimensionsInvalidated).not.toContain(VideoRoomRankingDimension.ROOMS);
    });

    it('returns the recompute results', async () => {
      await expect(service.replay('daily', '20260722')).resolves.toEqual([
        { status: 'RECOMPUTED' },
      ]);
    });

    // Finding 1 regression guard: the single most likely reason to use
    // `replay` is an operator backfilling a window the scheduler never
    // touched, meaning NO aggregation-log row exists for any dimension yet.
    // `invalidateAggregation` is backed by Prisma `updateMany`, which
    // resolves `{ count: 0 }` instead of throwing when nothing matches —
    // this must not abort the replay or prevent recomputeAll from running.
    it('completes successfully and still calls recomputeAll on a window with no existing log rows', async () => {
      repo.invalidateAggregation.mockResolvedValue(0);
      await expect(service.replay('daily', '20260722')).resolves.toEqual([
        { status: 'RECOMPUTED' },
      ]);
      expect(aggregation.recomputeAll).toHaveBeenCalledWith('daily', '20260722');
    });

    it('does not throw when guard invalidation affects zero rows for every dimension', async () => {
      repo.invalidateAggregation.mockResolvedValue(0);
      // If replay() rejected here, `await` below would throw and fail the
      // test — this is the direct "does not throw" assertion.
      await expect(service.replay('daily', '20260722')).resolves.toBeDefined();
    });
  });

  describe('rebuildFromSnapshot', () => {
    it('restores a Redis ladder from its persisted top-N', async () => {
      await expect(
        service.rebuildFromSnapshot('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722'),
      ).resolves.toBe(2);
      expect(store.replace).toHaveBeenCalledWith(
        'vrank:{g|hosts}:daily:20260722',
        [
          { member: 'u1', score: 900 },
          { member: 'u2', score: 400 },
        ],
        expect.any(Number),
      );
    });

    it('parses string scores back to numbers', async () => {
      await service.rebuildFromSnapshot('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(typeof store.replace.mock.calls[0][1][0].score).toBe('number');
    });

    it('returns 0 without touching Redis when no snapshot exists', async () => {
      repo.findLeaderboardSnapshot.mockResolvedValue(null);
      await expect(
        service.rebuildFromSnapshot('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722'),
      ).resolves.toBe(0);
      expect(store.replace).not.toHaveBeenCalled();
    });
  });
});
