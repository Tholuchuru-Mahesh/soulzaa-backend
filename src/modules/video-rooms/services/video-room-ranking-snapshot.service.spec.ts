import { RankingPeriodResolver } from 'src/modules/rankings/interfaces';
import { VideoRoomRankingDimension } from '../constants/video-room-ranking.constants';
import { VideoRoomRankingSnapshotService } from './video-room-ranking-snapshot.service';

describe('VideoRoomRankingSnapshotService', () => {
  const config = { get: () => ({}) } as never;
  let repo: any;
  let store: any;
  let bus: { publish: jest.Mock };
  let service: VideoRoomRankingSnapshotService;

  beforeEach(() => {
    repo = {
      saveRankingSnapshots: jest.fn().mockResolvedValue(2),
      upsertLeaderboardSnapshot: jest.fn().mockResolvedValue(undefined),
      pruneSnapshots: jest.fn().mockResolvedValue(7),
    };
    store = {
      key: jest.fn((ns, s, d, p, k) => `${ns}:{${s}|${d}}:${p}:${k}`),
      top: jest.fn().mockResolvedValue([
        { member: 'u1', score: 900 },
        { member: 'u2', score: 400 },
      ]),
      count: jest.fn().mockResolvedValue(57),
      expire: jest.fn().mockResolvedValue(1),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new VideoRoomRankingSnapshotService(
      config,
      repo,
      store,
      new RankingPeriodResolver(),
      bus as never,
    );
  });

  describe('snapshotLadder', () => {
    it('persists one ranked row per entry with a 1-based rank', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      const rows = repo.saveRankingSnapshots.mock.calls[0][0];
      expect(rows).toEqual([
        expect.objectContaining({ targetId: 'u1', rank: 1, score: 900n }),
        expect.objectContaining({ targetId: 'u2', rank: 2, score: 400n }),
      ]);
    });

    it('stores the score as BigInt — coin totals can exceed 2^53', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(typeof repo.saveRankingSnapshots.mock.calls[0][0][0].score).toBe('bigint');
    });

    it('also writes the materialised top-N row with the FULL ladder size', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(repo.upsertLeaderboardSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'g', dimension: 'hosts', totalEntries: 57 }),
      );
    });

    it('serialises entry scores as strings so the JSON column is valid', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      const { entries } = repo.upsertLeaderboardSnapshot.mock.calls[0][0];
      expect(() => JSON.stringify(entries)).not.toThrow();
      expect(entries[0]).toEqual({ targetId: 'u1', rank: 1, score: '900' });
    });

    it('TTLs the Redis ladder once it is durably persisted', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(store.expire).toHaveBeenCalledWith(
        'vrank:{g|hosts}:daily:20260722',
        expect.any(Number),
      );
    });

    it('writes nothing and does not TTL when the ladder is empty', async () => {
      store.top.mockResolvedValue([]);
      await expect(
        service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722'),
      ).resolves.toBe(0);
      expect(repo.saveRankingSnapshots).not.toHaveBeenCalled();
      expect(store.expire).not.toHaveBeenCalled();
    });

    it('publishes a snapshot-created event', async () => {
      await service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', '20260722');
      expect(bus.publish).toHaveBeenCalled();
    });

    it('rejects an invalid dateKey before reading Redis', async () => {
      await expect(
        service.snapshotLadder('g', VideoRoomRankingDimension.HOSTS, 'daily', 'nope'),
      ).rejects.toThrow();
      expect(store.top).not.toHaveBeenCalled();
    });
  });

  describe('snapshotAll', () => {
    // Finding 2 regression guard: `snapshotLadder` awaits `bus.publish`,
    // which fans out to arbitrary subscribers. A subscriber that does
    // `throw undefined` or a bare `Promise.reject()` must not make the
    // per-dimension catch itself throw (which `(err as Error).message`
    // would, since `undefined` has no `.message`) — that would abort every
    // remaining dimension, contradicting "one dimension failing must not
    // abandon the rest of the window".
    it('does not abandon the remaining dimensions when a rejection has no Error shape (e.g. Promise.reject())', async () => {
      bus.publish.mockRejectedValueOnce(undefined);

      await expect(service.snapshotAll('daily', '20260722')).resolves.toBeGreaterThan(0);

      // First dimension (HOSTS) attempted the write before the publish
      // rejected; every subsequent dimension must still run to completion.
      const dimensionsSnapshotted = repo.saveRankingSnapshots.mock.calls.length;
      expect(dimensionsSnapshotted).toBe(Object.values(VideoRoomRankingDimension).length);
    });

    it('does not abandon the remaining dimensions when a rejection is a bare thrown value with no .message', async () => {
      bus.publish.mockRejectedValueOnce('plain string rejection');

      await expect(service.snapshotAll('daily', '20260722')).resolves.toBeGreaterThan(0);
      expect(repo.saveRankingSnapshots).toHaveBeenCalledTimes(
        Object.values(VideoRoomRankingDimension).length,
      );
    });
  });

  describe('pruneExpired', () => {
    it('prunes each retained period at its own cutoff', async () => {
      const counts = await service.pruneExpired();
      expect(repo.pruneSnapshots).toHaveBeenCalledWith('hourly', expect.any(Date));
      expect(repo.pruneSnapshots).toHaveBeenCalledWith('daily', expect.any(Date));
      expect(repo.pruneSnapshots).toHaveBeenCalledWith('weekly', expect.any(Date));
      expect(counts).toEqual({ hourly: 7, daily: 7, weekly: 7 });
    });

    it('never prunes monthly, quarterly or yearly — those are retained forever', async () => {
      await service.pruneExpired();
      const periods = repo.pruneSnapshots.mock.calls.map((c: string[]) => c[0]);
      expect(periods).not.toContain('monthly');
      expect(periods).not.toContain('yearly');
    });
  });
});
