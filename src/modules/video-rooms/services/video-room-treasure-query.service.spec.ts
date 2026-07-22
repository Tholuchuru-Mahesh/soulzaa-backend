import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { VideoRoomTreasureQueryService } from './video-room-treasure-query.service';

const ACTOR = { id: 'u1', roles: [] } as never;

describe('VideoRoomTreasureQueryService', () => {
  let repo: Record<string, jest.Mock>;
  let rewards: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let perms: { assertPermission: jest.Mock };
  let progress: Record<string, jest.Mock>;
  let service: VideoRoomTreasureQueryService;

  beforeEach(() => {
    repo = {
      findCurrentSession: jest.fn().mockResolvedValue({
        id: 's1',
        roomId: 'r1',
        currentLevel: 2,
        status: TreasureSessionStatus.ACTIVE,
      }),
      listBoxes: jest.fn().mockResolvedValue([
        {
          id: 'b1',
          level: 1,
          threshold: 15_000n,
          progress: 15_000n,
          status: TreasureBoxStatus.OPENED,
          openedAt: new Date(0),
        },
        {
          id: 'b2',
          level: 2,
          threshold: 60_000n,
          progress: 12_000n,
          status: TreasureBoxStatus.ACTIVE,
          openedAt: null,
        },
      ]),
      listSessions: jest.fn().mockResolvedValue([[], 0]),
    };
    rewards = {
      listWinners: jest.fn().mockResolvedValue([[], 0]),
      statistics: jest
        .fn()
        .mockResolvedValue({ totalPools: 4, totalMinted: 12_000n, totalWinners: 12 }),
    };
    rooms = { findById: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner' }) };
    perms = { assertPermission: jest.fn().mockResolvedValue(undefined) };
    progress = {
      readStatusCache: jest.fn().mockResolvedValue(null),
      writeStatusCache: jest.fn().mockResolvedValue(undefined),
      invalidateStatus: jest.fn().mockResolvedValue(undefined),
      readStats: jest
        .fn()
        .mockResolvedValue({ boxesOpened: 2, totalMinted: 7_500, totalWinners: 6 }),
    };
    service = new VideoRoomTreasureQueryService(
      repo as never,
      rewards as never,
      rooms as never,
      perms as never,
      progress as never,
    );
  });

  describe('status', () => {
    it('reports inactive when the room has no ladder', async () => {
      repo.findCurrentSession.mockResolvedValue(null);
      expect(await service.status('r1')).toEqual({ active: false });
    });

    it('hides an archived ladder from the current-state read', async () => {
      repo.findCurrentSession.mockResolvedValue({
        id: 's1',
        status: TreasureSessionStatus.ARCHIVED,
      });
      expect(await service.status('r1')).toEqual({ active: false });
    });

    it('computes remaining coins and completion percentage per box', async () => {
      const res = await service.status('r1');
      expect(res.boxes![1]).toEqual(
        expect.objectContaining({
          level: 2,
          progress: 12_000,
          threshold: 60_000,
          remaining: 48_000,
          percent: 20,
        }),
      );
    });

    it('reports an opened box as 100% with zero remaining', async () => {
      const res = await service.status('r1');
      expect(res.boxes![0]).toEqual(
        expect.objectContaining({ percent: 100, remaining: 0, status: 'OPENED' }),
      );
    });

    // The tail of a combo gift can overfill a box; the UI must not read >100%.
    it('clamps an overfilled box to 100%', async () => {
      repo.listBoxes.mockResolvedValue([
        {
          id: 'b1',
          level: 1,
          threshold: 15_000n,
          progress: 40_000n,
          status: TreasureBoxStatus.OPENED,
          openedAt: null,
        },
      ]);
      const res = await service.status('r1');
      expect(res.boxes![0].percent).toBe(100);
      expect(res.boxes![0].remaining).toBe(0);
    });

    // A BigInt reaching JSON.stringify throws at the serialiser.
    it('converts every BigInt to a number at the DTO boundary', async () => {
      const res = await service.status('r1');
      for (const box of res.boxes!) {
        expect(typeof box.progress).toBe('number');
        expect(typeof box.threshold).toBe('number');
        expect(typeof box.remaining).toBe('number');
      }
      expect(() => JSON.stringify(res)).not.toThrow();
    });
  });

  describe('status read-through cache', () => {
    it('serves a cache hit without touching Postgres', async () => {
      progress.readStatusCache.mockResolvedValue({ active: true, sessionId: 'cached' });
      const res = await service.status('r1');
      expect(res).toEqual({ active: true, sessionId: 'cached' });
      expect(repo.findCurrentSession).not.toHaveBeenCalled();
    });

    it('computes and caches on a miss', async () => {
      await service.status('r1');
      expect(repo.findCurrentSession).toHaveBeenCalled();
      expect(progress.writeStatusCache).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({ active: true }),
      );
    });

    // A Redis fault must degrade to Postgres, never fail the read.
    it('falls back to Postgres when the cache read throws', async () => {
      progress.readStatusCache.mockRejectedValue(new Error('redis down'));
      const res = await service.status('r1');
      expect(res.active).toBe(true);
    });

    it('still returns the view when the cache write throws', async () => {
      progress.writeStatusCache.mockRejectedValue(new Error('redis down'));
      await expect(service.status('r1')).resolves.toEqual(
        expect.objectContaining({ active: true }),
      );
    });
  });

  describe('statistics', () => {
    it('requires VIEW_ANALYTICS against the resolved room ref', async () => {
      await service.statistics(ACTOR, 'r1');
      expect(perms.assertPermission).toHaveBeenCalledWith(
        ACTOR,
        { id: 'r1', ownerId: 'owner' },
        'VIEW_ANALYTICS',
      );
    });

    it('returns durable minted totals as numbers', async () => {
      expect(await service.statistics(ACTOR, 'r1')).toEqual(
        expect.objectContaining({ totalPools: 4, totalMinted: 12_000, totalWinners: 12 }),
      );
    });

    // The Redis counters are what make an in-flight session legible; the
    // durable aggregate only catches up as boxes commit.
    it('folds in live session counters while a ladder is running', async () => {
      const res = await service.statistics(ACTOR, 'r1');
      expect(res.live).toEqual({ boxesOpened: 2, totalMinted: 7_500, totalWinners: 6 });
    });

    it('reports no live block when the room has no ladder', async () => {
      repo.findCurrentSession.mockResolvedValue(null);
      expect((await service.statistics(ACTOR, 'r1')).live).toBeNull();
      expect(progress.readStats).not.toHaveBeenCalled();
    });

    // Redis is a convenience read, never the source of truth.
    it('still returns durable totals when the live read fails', async () => {
      progress.readStats.mockRejectedValue(new Error('redis down'));
      const res = await service.statistics(ACTOR, 'r1');
      expect(res.totalPools).toBe(4);
      expect(res.live).toBeNull();
    });
  });

  describe('winners', () => {
    it('serialises amounts and timestamps for the wire', async () => {
      rewards.listWinners.mockResolvedValue([
        [
          {
            boxId: 'b1',
            sessionId: 's1',
            userId: 'u9',
            algorithm: 'RANDOM',
            shareBps: 3333,
            amount: 500n,
            eligibleCount: 9,
            candidateCount: 50,
            selectedAt: new Date(0),
          },
        ],
        1,
      ]);
      const res = (await service.winners('r1', { skip: 0, limit: 20, page: 1 })) as {
        items: Record<string, unknown>[];
      };
      expect(res.items[0]).toEqual(
        expect.objectContaining({ amount: 500, selectedAt: '1970-01-01T00:00:00.000Z' }),
      );
      expect(() => JSON.stringify(res)).not.toThrow();
    });
  });
});
