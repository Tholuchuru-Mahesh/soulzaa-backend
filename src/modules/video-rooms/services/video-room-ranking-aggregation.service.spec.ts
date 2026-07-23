import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingAggregationService } from './video-room-ranking-aggregation.service';
import { VideoRoomRankingScoreEngine } from './video-room-ranking-score.engine';

describe('VideoRoomRankingAggregationService', () => {
  const config = { get: () => ({}) } as never;
  let repo: any;
  let store: any;
  let scopes: { geoForMany: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomRankingAggregationService;

  beforeEach(() => {
    repo = {
      beginAggregation: jest.fn().mockResolvedValue('CLAIMED'),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
      failAggregation: jest.fn().mockResolvedValue(undefined),
      aggregateGiftCoinsBySender: jest
        .fn()
        .mockResolvedValue([{ userId: 'u1', coins: 500n, gifts: 3 }]),
      aggregateGiftCoinsByReceiver: jest.fn().mockResolvedValue([]),
      aggregateGiftCoinsByRoom: jest.fn().mockResolvedValue([]),
      aggregatePkOutcomes: jest.fn().mockResolvedValue([]),
      aggregateTreasureWinnings: jest.fn().mockResolvedValue([]),
      findRoomStatistics: jest.fn().mockResolvedValue([]),
    };
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      replace: jest.fn().mockResolvedValue(undefined),
      derive: jest.fn().mockResolvedValue(4),
      bumpVersion: jest.fn().mockResolvedValue(2),
    };
    scopes = {
      geoForMany: jest.fn().mockResolvedValue(new Map([['u1', { country: 'IN', city: 'c9' }]])),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };

    service = new VideoRoomRankingAggregationService(
      config,
      repo,
      store,
      new RankingPeriodResolver(),
      new VideoRoomRankingScoreEngine(config),
      scopes as never,
      bus as never,
    );
  });

  describe('recomputeDimension', () => {
    it('claims the window before doing any work', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(repo.beginAggregation).toHaveBeenCalledWith(
        { scope: 'g', dimension: 'gifters', period: 'daily', dateKey: '20260722' },
        new Date('2026-07-22T00:00:00.000Z'),
        new Date('2026-07-23T00:00:00.000Z'),
      );
    });

    it('skips entirely when the window already succeeded', async () => {
      repo.beginAggregation.mockResolvedValue('ALREADY_SUCCEEDED');
      const result = await service.recomputeDimension(
        VideoRoomRankingDimension.GIFTERS,
        'daily',
        '20260722',
      );
      expect(result.status).toBe('SKIPPED');
      expect(repo.aggregateGiftCoinsBySender).not.toHaveBeenCalled();
      expect(store.replace).not.toHaveBeenCalled();
    });

    it('replaces the ladder atomically rather than incrementing it', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(store.replace).toHaveBeenCalled();
      const [key, entries] = store.replace.mock.calls[0];
      expect(key).toBe('vrank:{g|gifters}:daily:20260722');
      expect(entries).toEqual([{ member: 'u1', score: 500 }]);
    });

    it('rebuilds the country and city ladders from the same source rows', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      const keys = store.replace.mock.calls.map((c: unknown[]) => c[0]);
      expect(keys).toContain('vrank:{c:IN|gifters}:daily:20260722');
      expect(keys).toContain('vrank:{y:c9|gifters}:daily:20260722');
    });

    it('produces the same score the incremental path would have', async () => {
      // gifters is a pass-through dimension: 500 coins spent → score 500.
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(store.replace.mock.calls[0][1][0].score).toBe(500);
    });

    it('marks the window succeeded with its stats', async () => {
      const result = await service.recomputeDimension(
        VideoRoomRankingDimension.GIFTERS,
        'daily',
        '20260722',
      );
      expect(result.status).toBe('RECOMPUTED');
      expect(repo.completeAggregation).toHaveBeenCalledWith(
        expect.objectContaining({ dimension: 'gifters' }),
        expect.objectContaining({ entriesWritten: 1, sourceRows: 1 }),
      );
    });

    it('bumps the ladder version so cached pages invalidate', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(store.bumpVersion).toHaveBeenCalled();
    });

    it('publishes an aggregated event', async () => {
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(bus.publish).toHaveBeenCalled();
    });

    it('records the failure and rethrows so BullMQ can retry', async () => {
      repo.aggregateGiftCoinsBySender.mockRejectedValue(new Error('db down'));
      await expect(
        service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722'),
      ).rejects.toThrow('db down');
      expect(repo.failAggregation).toHaveBeenCalled();
    });

    it('rejects an invalid dateKey before touching the database', async () => {
      await expect(
        service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260732'),
      ).rejects.toThrow();
      expect(repo.beginAggregation).not.toHaveBeenCalled();
    });

    it('clears a ladder whose window turned out to be empty', async () => {
      repo.aggregateGiftCoinsBySender.mockResolvedValue([]);
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');
      expect(store.replace).toHaveBeenCalledWith(expect.any(String), [], expect.any(Number));
    });

    it('does not include a giftCoins term in the PK composite, matching the live path', async () => {
      // wins:1 * 1000 + losses:0 * 0 + score:10 * 1 = 1010. If giftCoins were
      // wired in, weights.pk.giftCoins (0.5) * 1000 would add another 500 —
      // the live path never adds this term, so it must not appear here either.
      repo.aggregatePkOutcomes.mockResolvedValue([
        { userId: 'u1', wins: 1, losses: 0, score: 10n, giftCoins: 1000n },
      ]);
      await service.recomputeDimension(VideoRoomRankingDimension.PK, 'daily', '20260722');
      const [, entries] = store.replace.mock.calls[0];
      expect(entries).toEqual([{ member: 'u1', score: 1010 }]);
    });

    it.each([VideoRoomRankingDimension.HOSTS, VideoRoomRankingDimension.ROOMS])(
      'refuses to recompute %s directly and does no work',
      async (dimension) => {
        const result = await service.recomputeDimension(dimension, 'daily', '20260722');

        expect(result.status).toBe('SKIPPED');
        expect(result.entriesWritten).toBe(0);
        expect(result.sourceRows).toBe(0);
        expect(repo.beginAggregation).not.toHaveBeenCalled();
        expect(repo.aggregateGiftCoinsByReceiver).not.toHaveBeenCalled();
        expect(repo.aggregateGiftCoinsByRoom).not.toHaveBeenCalled();
        expect(repo.findRoomStatistics).not.toHaveBeenCalled();
        expect(repo.completeAggregation).not.toHaveBeenCalled();
        expect(repo.failAggregation).not.toHaveBeenCalled();
        expect(store.replace).not.toHaveBeenCalled();
        expect(store.bumpVersion).not.toHaveBeenCalled();
        expect(bus.publish).not.toHaveBeenCalled();
      },
    );
  });

  describe('recomputeAll', () => {
    it('skips hosts and rooms while still recomputing every other dimension', async () => {
      const results = await service.recomputeAll('daily', '20260722');

      const byDimension = new Map(results.map((r) => [r.key.dimension, r]));
      expect(byDimension.get(VideoRoomRankingDimension.HOSTS)?.status).toBe('SKIPPED');
      expect(byDimension.get(VideoRoomRankingDimension.ROOMS)?.status).toBe('SKIPPED');
      expect(byDimension.get(VideoRoomRankingDimension.GIFTERS)?.status).toBe('RECOMPUTED');

      // No source query for either excluded dimension, on top of the direct
      // per-dimension coverage above.
      expect(repo.aggregateGiftCoinsByRoom).not.toHaveBeenCalled();
      expect(repo.findRoomStatistics).not.toHaveBeenCalled();

      // beginAggregation/completeAggregation ran for every dimension EXCEPT
      // the two excluded ones (gifters, receivers, pk, treasure, vip) —
      // never for hosts/rooms — so the call count is the full enum minus 2,
      // not every dimension in the enum.
      const allDimensions = Object.values(VideoRoomRankingDimension);
      expect(repo.beginAggregation).toHaveBeenCalledTimes(allDimensions.length - 2);
      expect(repo.completeAggregation).toHaveBeenCalledTimes(allDimensions.length - 2);
    });

    it('writes no ladder entries for the excluded dimensions', async () => {
      await service.recomputeAll('daily', '20260722');
      const writtenDimensions = store.replace.mock.calls.map(
        (c: unknown[]) => (c[0] as string).split(':')[1],
      );
      // Every key `store.replace` was called with belongs to a recomputable
      // dimension's ladder — never `hosts` or `rooms`.
      expect(writtenDimensions.every((d: string) => !d.includes('hosts'))).toBe(true);
      expect(writtenDimensions.every((d: string) => !d.includes('rooms'))).toBe(true);
    });
  });

  describe('scope clearing — documented limitation', () => {
    it('does NOT clear a country ladder whose scope produced no rows this window', async () => {
      // Locks in the known gap described above `writeScopedLadders`: a scope
      // absent from this run's rows is never visited, so it is never
      // cleared. If this starts failing, the limitation comment needs
      // updating alongside whatever closed the gap.
      repo.aggregateGiftCoinsBySender.mockResolvedValue([{ userId: 'u1', coins: 500n, gifts: 3 }]);
      await service.recomputeDimension(VideoRoomRankingDimension.GIFTERS, 'daily', '20260722');

      const touchedKeys = store.replace.mock.calls.map((c: unknown[]) => c[0]);
      expect(touchedKeys).toContain('vrank:{g|gifters}:daily:20260722');
      expect(touchedKeys).toContain('vrank:{c:IN|gifters}:daily:20260722');
      // A country with no rows THIS run — e.g. one that had entries in a
      // prior run — is simply never in `touchedKeys`, so its stale ladder
      // is left exactly as it was; nothing clears it.
      expect(touchedKeys).not.toContain('vrank:{c:US|gifters}:daily:20260722');
    });
  });

  describe('derivePeriod', () => {
    it('unions a quarter from its three monthly keys', async () => {
      await service.derivePeriod(VideoRoomRankingDimension.HOSTS, 'quarterly', '2026Q3');
      expect(store.derive).toHaveBeenCalledWith(
        'vrank:{g|hosts}:quarterly:2026Q3',
        [
          'vrank:{g|hosts}:monthly:202607',
          'vrank:{g|hosts}:monthly:202608',
          'vrank:{g|hosts}:monthly:202609',
        ],
        expect.any(Number),
      );
    });

    it('refuses to derive a hot period, which is materialised not derived', async () => {
      await expect(
        service.derivePeriod(VideoRoomRankingDimension.HOSTS, 'daily', '20260722'),
      ).rejects.toThrow();
    });
  });
});
