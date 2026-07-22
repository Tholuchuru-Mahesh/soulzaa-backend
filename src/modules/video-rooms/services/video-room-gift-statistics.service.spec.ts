import { VideoRoomGiftStatisticsService } from './video-room-gift-statistics.service';

const ROOM = 'r1';

const txn = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 't1',
    senderId: 's1',
    receiverId: 'u1',
    giftId: 'g1',
    quantity: 1,
    comboTier: 1,
    totalCoinValue: 100n,
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
    metadata: { batchId: 'b1', giftName: 'Rocket' },
    ...overrides,
  }) as never;

describe('VideoRoomGiftStatisticsService', () => {
  let repo: Record<string, jest.Mock>;
  let cache: Record<string, jest.Mock>;
  let redis: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let service: VideoRoomGiftStatisticsService;

  beforeEach(() => {
    repo = {
      incrementGiftTotals: jest.fn().mockResolvedValue(undefined),
      findStatistics: jest.fn().mockResolvedValue({ totalGifts: 5n, totalGiftCoins: 500n }),
      aggregateByReceiver: jest.fn().mockResolvedValue([]),
      aggregateBySender: jest.fn().mockResolvedValue([]),
    };
    cache = {
      addScore: jest.fn().mockResolvedValue(1),
      top: jest.fn().mockResolvedValue([]),
    };
    redis = {
      hincrby: jest.fn().mockResolvedValue(1),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      lrange: jest.fn().mockResolvedValue([]),
    };
    config = {
      get: jest.fn().mockReturnValue({
        maxReceivers: 9,
        allowRoomAll: 'false',
        allowViewerGiftsDefault: 'true',
        recentFeedSize: 50,
        monitorIntervalSeconds: 15,
        recoveryEnabled: 'false',
      }),
    };
    service = new VideoRoomGiftStatisticsService(
      repo as never,
      cache as never,
      redis as never,
      config as never,
    );
  });

  describe('record', () => {
    it('increments the durable totals by the batch sum', async () => {
      await service.record(ROOM, [txn(), txn({ id: 't2', totalCoinValue: 200n })]);
      expect(repo.incrementGiftTotals).toHaveBeenCalledWith(ROOM, 2, 300n);
    });

    it('does nothing for an empty batch', async () => {
      await service.record(ROOM, []);
      expect(repo.incrementGiftTotals).not.toHaveBeenCalled();
      expect(redis.lpush).not.toHaveBeenCalled();
    });

    it('ranks top gifts by send count and top senders by coins', async () => {
      await service.record(ROOM, [txn()]);
      expect(cache.addScore).toHaveBeenCalledWith('video-room:r1:gift:top', 'g1', 1);
      expect(cache.addScore).toHaveBeenCalledWith('video-room:r1:gift:top-senders', 's1', 100);
    });

    it('caps the recent feed at the configured size', async () => {
      await service.record(ROOM, [txn()]);
      expect(redis.ltrim).toHaveBeenCalledWith('video-room:r1:gifts:recent', 0, 49);
    });

    it('pushes the newest entry to the head of the feed', async () => {
      await service.record(ROOM, [txn()]);
      const [key, entry] = redis.lpush.mock.calls[0];
      expect(key).toBe('video-room:r1:gifts:recent');
      expect(JSON.parse(entry)).toMatchObject({
        transactionId: 't1',
        batchId: 'b1',
        giftName: 'Rocket',
        totalCoinValue: 100,
      });
    });

    it('never throws when the durable counter update fails', async () => {
      repo.incrementGiftTotals.mockRejectedValue(new Error('row missing'));
      await expect(service.record(ROOM, [txn()])).resolves.toBeUndefined();
      // The send already committed; Redis work must still proceed.
      expect(redis.lpush).toHaveBeenCalled();
    });
  });

  describe('recent', () => {
    it('reads Redis only, never Postgres', async () => {
      redis.lrange.mockResolvedValue([JSON.stringify({ transactionId: 't1' })]);
      const feed = await service.recent(ROOM);
      expect(feed).toEqual([{ transactionId: 't1' }]);
      expect(repo.aggregateByReceiver).not.toHaveBeenCalled();
    });

    it('skips malformed entries rather than failing the request', async () => {
      redis.lrange.mockResolvedValue(['not json', JSON.stringify({ transactionId: 't2' })]);
      await expect(service.recent(ROOM)).resolves.toEqual([{ transactionId: 't2' }]);
    });

    it('returns an empty feed on cold Redis', async () => {
      redis.lrange.mockResolvedValue([]);
      await expect(service.recent(ROOM)).resolves.toEqual([]);
    });
  });

  describe('summary', () => {
    it('reads durable counters, not Redis, for the totals', async () => {
      const summary = await service.summary(ROOM);
      expect(summary).toMatchObject({ totalGifts: 5, totalGiftCoins: 500 });
    });

    it('reports zeros for a room with no statistics row', async () => {
      repo.findStatistics.mockResolvedValue(null);
      await expect(service.summary(ROOM)).resolves.toMatchObject({
        totalGifts: 0,
        totalGiftCoins: 0,
      });
    });

    it('projects the top ZSETs into named shapes', async () => {
      cache.top.mockResolvedValueOnce([{ member: 'g1', score: 7, rank: 1 }]);
      cache.top.mockResolvedValueOnce([{ member: 's1', score: 900, rank: 1 }]);
      const summary = await service.summary(ROOM);
      expect(summary.topGifts).toEqual([{ giftId: 'g1', count: 7 }]);
      expect(summary.topSenders).toEqual([{ userId: 's1', coins: 900 }]);
    });
  });

  describe('breakdown', () => {
    it('delegates room-scoped aggregation to the repository (no Prisma in services)', async () => {
      await service.breakdown(ROOM);
      expect(repo.aggregateByReceiver).toHaveBeenCalledWith(ROOM);
      expect(repo.aggregateBySender).toHaveBeenCalledWith(ROOM);
    });

    it('projects receiver earnings and sender totals', async () => {
      repo.aggregateByReceiver.mockResolvedValue([
        { receiverId: 'u1', earnings: 30, coins: 100, gifts: 1 },
      ]);
      repo.aggregateBySender.mockResolvedValue([{ senderId: 's1', coins: 100, gifts: 1 }]);
      const breakdown = await service.breakdown(ROOM);
      expect(breakdown.receiverEarnings).toEqual([{ receiverId: 'u1', coins: 30, gifts: 1 }]);
      expect(breakdown.senderTotals).toEqual([{ senderId: 's1', coins: 100, gifts: 1 }]);
      expect(breakdown.uniqueSenders).toBe(1);
    });
  });
});
