import { RankingPeriodResolver } from 'src/modules/rankings/services/ranking-period.resolver';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingQueryService } from './video-room-ranking-query.service';

const MEMBER = { id: 'u1', isGuest: false };
const GUEST = { id: 'g1', isGuest: true };
const query = (over = {}) => ({
  dimension: VideoRoomRankingDimension.HOSTS,
  period: 'daily' as const,
  limit: 20,
  page: 1,
  ...over,
});

describe('VideoRoomRankingQueryService', () => {
  const config = { get: () => ({}) } as never;
  let store: any;
  let cache: { read: jest.Mock; write: jest.Mock };
  let repo: any;
  let metrics: { observeRankingApi: jest.Mock };
  let service: VideoRoomRankingQueryService;

  beforeEach(() => {
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      range: jest.fn().mockResolvedValue([
        { member: 'u1', score: 900 },
        { member: 'u2', score: 400 },
      ]),
      count: jest.fn().mockResolvedValue(2),
      rank: jest.fn().mockResolvedValue(0),
      score: jest.fn().mockResolvedValue(900),
    };
    cache = {
      read: jest.fn().mockResolvedValue(null),
      write: jest.fn().mockResolvedValue(undefined),
    };
    repo = {
      findRankingSnapshots: jest.fn().mockResolvedValue([[], 0]),
      findLeaderboardSnapshot: jest.fn().mockResolvedValue(null),
      findTargetHistory: jest.fn().mockResolvedValue([]),
      hydrateTargets: jest.fn().mockResolvedValue([
        { id: 'u1', username: 'alice', avatarKey: 'a.png', level: 3, vipLevel: 1 },
        { id: 'u2', username: 'bob', avatarKey: null, level: 2, vipLevel: 0 },
      ]),
    };
    metrics = { observeRankingApi: jest.fn() };
    service = new VideoRoomRankingQueryService(
      config,
      store,
      cache as never,
      new RankingPeriodResolver(),
      repo,
      metrics as never,
    );
  });

  describe('getLadder', () => {
    it('returns hydrated, 1-based ranked entries', async () => {
      const result = await service.getLadder(MEMBER, query());
      expect(result.items[0]).toEqual(
        expect.objectContaining({ rank: 1, targetId: 'u1', username: 'alice', score: 900 }),
      );
      expect(result.items[1].rank).toBe(2);
    });

    it('continues ranks across pages rather than restarting at 1', async () => {
      const result = await service.getLadder(MEMBER, query({ page: 3, limit: 20 }));
      expect(result.items[0].rank).toBe(41);
    });

    it('serves a cache hit without touching Redis ZSETs', async () => {
      // `limit` on the cached payload must match the request's effective
      // limit (20, the default) for the hit to be honoured — see Finding 1.
      cache.read.mockResolvedValue({
        items: [{ rank: 1, targetId: 'u1' }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
      const result = await service.getLadder(MEMBER, query());
      expect(store.range).not.toHaveBeenCalled();
      expect(result.items).toEqual([{ rank: 1, targetId: 'u1' }]);
    });

    it('writes the page to cache on a miss', async () => {
      await service.getLadder(MEMBER, query());
      expect(cache.write).toHaveBeenCalled();
    });

    it('caps a guest at the top ten', async () => {
      await service.getLadder(GUEST, query({ limit: 100 }));
      // start 0, stop 9 — never beyond rank 10.
      expect(store.range).toHaveBeenCalledWith(expect.any(String), 0, 9);
    });

    describe('Finding 1: the page cache cannot bypass the guest cap or the member limit', () => {
      it('never reads the page cache for a guest', async () => {
        await service.getLadder(GUEST, query({ limit: 100 }));
        expect(cache.read).not.toHaveBeenCalled();
      });

      it('never writes the page cache for a guest', async () => {
        await service.getLadder(GUEST, query({ limit: 100 }));
        expect(cache.write).not.toHaveBeenCalled();
      });

      it('a guest never receives a member-warmed cache page beyond the guest cap', async () => {
        // Simulate a member having warmed page 1 with a full 20-item page
        // under the exact same cache key a guest's request maps to (the key
        // has no limit/audience component).
        cache.read.mockResolvedValue({
          items: Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, targetId: `u${i}` })),
          total: 20,
          page: 1,
          limit: 20,
          totalPages: 1,
        });
        const result = await service.getLadder(GUEST, query({ limit: 100 }));
        expect(cache.read).not.toHaveBeenCalled();
        expect(result.items.length).toBeLessThanOrEqual(10);
      });

      it('a member never receives a stale differently-sized cached page (limit mismatch is a miss)', async () => {
        // Simulate a stale/guest-shaped 10-item entry sitting under the same
        // key a limit=100 member request maps to.
        cache.read.mockResolvedValue({
          items: [{ rank: 1, targetId: 'u1' }],
          total: 1,
          page: 1,
          limit: 10,
          totalPages: 1,
        });
        const result = await service.getLadder(MEMBER, query({ limit: 100 }));
        // The mismatch must be treated as a miss: Redis is consulted, and
        // the stale 1-item cached page must not be returned as-is.
        expect(store.range).toHaveBeenCalled();
        expect(result.items).not.toEqual([{ rank: 1, targetId: 'u1' }]);
      });

      it('re-caches the freshly computed page after a limit-mismatch miss', async () => {
        cache.read.mockResolvedValue({
          items: [{ rank: 1, targetId: 'u1' }],
          total: 1,
          page: 1,
          limit: 10,
          totalPages: 1,
        });
        await service.getLadder(MEMBER, query({ limit: 100 }));
        expect(cache.write).toHaveBeenCalled();
      });
    });

    describe('Finding 2: page must be floored at 1', () => {
      it('page=0 does not return the bottom of the ladder', async () => {
        await service.getLadder(MEMBER, query({ page: 0, limit: 20 }));
        const [, start, stop] = store.range.mock.calls[0];
        expect(start).toBe(0);
        expect(stop).toBe(19);
      });

      it('a negative page is also floored at 1', async () => {
        await service.getLadder(MEMBER, query({ page: -5, limit: 20 }));
        const [, start] = store.range.mock.calls[0];
        expect(start).toBe(0);
      });
    });

    describe('Finding 3: the snapshot fallback degrades instead of throwing', () => {
      it('returns an empty page when both Redis and the snapshot read fail', async () => {
        store.range.mockRejectedValue(new Error('CONNRESET'));
        repo.findLeaderboardSnapshot.mockRejectedValue(new Error('pg unavailable'));
        const result = await service.getLadder(MEMBER, query());
        expect(result.items).toEqual([]);
        expect(result.total).toBe(0);
      });

      it('returns an empty page when the snapshot payload is malformed', async () => {
        store.range.mockRejectedValue(new Error('CONNRESET'));
        repo.findLeaderboardSnapshot.mockResolvedValue({
          entries: null,
          totalEntries: 5,
        });
        const result = await service.getLadder(MEMBER, query());
        expect(result.items).toEqual([]);
        expect(result.total).toBe(0);
      });
    });

    it('records API latency even when the read throws', async () => {
      // The brief's suggested throw scenario — Redis AND the snapshot
      // fallback both failing — is exactly Finding 3's "degrades instead of
      // throwing" case: `fromRedis` deliberately swallows both failures and
      // resolves to an empty page (see the `Finding 3` describe block above),
      // so it cannot be reused here to prove a REJECTED read is still timed.
      // `hydrateTargets` is a genuinely un-caught call in `hydrate()`, so
      // rejecting it exercises a real "the read throws" path without
      // weakening Finding 3's swallow-and-degrade assertions.
      repo.hydrateTargets.mockRejectedValue(new Error('hydrate down'));
      await expect(service.getLadder(MEMBER, query())).rejects.toThrow('hydrate down');
      expect(metrics.observeRankingApi).toHaveBeenCalledWith('hosts', expect.any(Number));
    });

    it('refuses a guest any page beyond the first', async () => {
      await expect(service.getLadder(GUEST, query({ page: 2 }))).rejects.toThrow();
    });

    it('refuses a guest a historical dateKey', async () => {
      await expect(service.getLadder(GUEST, query({ dateKey: '20260701' }))).rejects.toThrow();
    });

    it('rejects an unknown dimension', async () => {
      await expect(
        service.getLadder(MEMBER, query({ dimension: 'families' as never })),
      ).rejects.toThrow();
    });

    it('rejects a malformed dateKey with a 400-class error', async () => {
      await expect(service.getLadder(MEMBER, query({ dateKey: '2026-07-22' }))).rejects.toThrow();
    });

    it('reads a closed window from snapshots instead of Redis', async () => {
      repo.findRankingSnapshots.mockResolvedValue([
        [{ targetId: 'u1', rank: 1, score: 900n, metrics: null }],
        1,
      ]);
      const result = await service.getLadder(MEMBER, query({ dateKey: '20260101' }));
      expect(repo.findRankingSnapshots).toHaveBeenCalled();
      expect(store.range).not.toHaveBeenCalled();
      expect(result.items[0].targetId).toBe('u1');
    });

    it('falls back to the durable snapshot when Redis is unavailable', async () => {
      store.range.mockRejectedValue(new Error('CONNRESET'));
      repo.findLeaderboardSnapshot.mockResolvedValue({
        entries: [{ targetId: 'u1', rank: 1, score: '900' }],
        totalEntries: 1,
      });
      const result = await service.getLadder(MEMBER, query());
      // A stale ladder beats a 500.
      expect(result.items[0].targetId).toBe('u1');
    });
  });

  describe('getSelfRank', () => {
    it('returns a 1-based rank for a member', async () => {
      const self = await service.getSelfRank(MEMBER, VideoRoomRankingDimension.HOSTS, 'daily');
      expect(self).toEqual(expect.objectContaining({ rank: 1, score: 900 }));
    });

    it('returns null rank when the member is not on the ladder', async () => {
      store.rank.mockResolvedValue(null);
      const self = await service.getSelfRank(MEMBER, VideoRoomRankingDimension.HOSTS, 'daily');
      expect(self.rank).toBeNull();
    });

    it('refuses a guest entirely', async () => {
      await expect(
        service.getSelfRank(GUEST, VideoRoomRankingDimension.HOSTS, 'daily'),
      ).rejects.toThrow();
    });
  });
});
