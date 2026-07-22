import { VideoRoomGiftQueryService } from './video-room-gift-query.service';

const ROOM = 'r1';

const row = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 't1',
    senderId: 's1',
    receiverId: 'u1',
    giftId: 'g1',
    giftType: 'ANIMATED',
    quantity: 1,
    comboTier: 2,
    totalCoinValue: 100n,
    creatorEarnings: 30n,
    isLuckyWin: false,
    luckyMultiplier: 1,
    status: 'COMPLETED',
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
    metadata: { batchId: 'b1' },
    ...overrides,
  }) as never;

const query = (overrides: Record<string, unknown> = {}) =>
  ({ page: 1, limit: 20, skip: 0, ...overrides }) as never;

describe('VideoRoomGiftQueryService', () => {
  let gifts: { listTransactions: jest.Mock };
  let combo: { listActive: jest.Mock };
  let statistics: Record<string, jest.Mock>;
  let rooms: { findById: jest.Mock };
  let permissions: { hasPermission: jest.Mock };
  let service: VideoRoomGiftQueryService;

  const whereOf = () => gifts.listTransactions.mock.calls[0][0];

  beforeEach(() => {
    gifts = { listTransactions: jest.fn().mockResolvedValue([[row()], 1]) };
    combo = { listActive: jest.fn().mockResolvedValue([]) };
    statistics = {
      recent: jest.fn().mockResolvedValue([]),
      summary: jest.fn().mockResolvedValue({ totalGifts: 5 }),
      breakdown: jest.fn().mockResolvedValue({ totalGifts: 5, uniqueSenders: 2 }),
    };
    rooms = { findById: jest.fn().mockResolvedValue({ id: ROOM, ownerId: 'owner-1' }) };
    permissions = { hasPermission: jest.fn().mockResolvedValue(false) };
    service = new VideoRoomGiftQueryService(
      gifts as never,
      combo as never,
      statistics as never,
      rooms as never,
      permissions as never,
    );
  });

  describe('history', () => {
    it('scopes to VIDEO_ROOM and this room', async () => {
      await service.history(ROOM, query());
      expect(whereOf()).toMatchObject({ contextType: 'VIDEO_ROOM', contextId: ROOM });
    });

    it('applies the sender, receiver and gift filters', async () => {
      await service.history(ROOM, query({ senderId: 's9', receiverId: 'u9', giftId: 'g9' }));
      expect(whereOf()).toMatchObject({ senderId: 's9', receiverId: 'u9', giftId: 'g9' });
    });

    it('applies a date range', async () => {
      await service.history(ROOM, query({ from: '2026-07-01', to: '2026-07-31' }));
      expect(whereOf().createdAt).toEqual({
        gte: new Date('2026-07-01'),
        lte: new Date('2026-07-31'),
      });
    });

    it('omits createdAt entirely when no dates are given', async () => {
      await service.history(ROOM, query());
      expect(whereOf().createdAt).toBeUndefined();
    });

    it('supports an open-ended range', async () => {
      await service.history(ROOM, query({ from: '2026-07-01' }));
      expect(whereOf().createdAt).toEqual({ gte: new Date('2026-07-01') });
    });

    it('passes pagination through to the repository', async () => {
      await service.history(ROOM, query({ skip: 40, limit: 20, page: 3 }));
      expect(gifts.listTransactions).toHaveBeenCalledWith(expect.anything(), 40, 20);
    });

    it('returns a paginated envelope of client-safe entries', async () => {
      const result = await service.history(ROOM, query());
      expect(result).toMatchObject({ total: 1, page: 1 });
      expect(result.items[0]).toEqual({
        transactionId: 't1',
        batchId: 'b1',
        senderId: 's1',
        receiverId: 'u1',
        giftId: 'g1',
        giftType: 'ANIMATED',
        quantity: 1,
        comboTier: 2,
        coinValue: 100,
        receiverEarnings: 30,
        isLuckyWin: false,
        luckyMultiplier: 1,
        status: 'COMPLETED',
        createdAt: new Date('2026-07-22T00:00:00.000Z'),
      });
    });

    it('tolerates a row with no batchId in metadata', async () => {
      gifts.listTransactions.mockResolvedValue([[row({ metadata: null })], 1]);
      const result = await service.history(ROOM, query());
      expect(result.items[0].batchId).toBeNull();
    });
  });

  describe('recent', () => {
    it('reads the Redis feed, never the ledger', async () => {
      statistics.recent.mockResolvedValue([{ transactionId: 't1' }]);
      await expect(service.recent(ROOM)).resolves.toEqual([{ transactionId: 't1' }]);
      expect(gifts.listTransactions).not.toHaveBeenCalled();
    });
  });

  describe('combos', () => {
    it('delegates to the combo service', async () => {
      combo.listActive.mockResolvedValue([{ senderId: 's1', giftId: 'g1', tier: 3 }]);
      await expect(service.combos(ROOM)).resolves.toHaveLength(1);
      expect(combo.listActive).toHaveBeenCalledWith(ROOM);
    });

    it('returns an empty list on a cold cache rather than erroring', async () => {
      combo.listActive.mockResolvedValue([]);
      await expect(service.combos(ROOM)).resolves.toEqual([]);
    });
  });

  describe('statisticsFor', () => {
    const ACTOR = { id: 'u1', roles: [] } as never;

    it('returns only the summary for a plain member', async () => {
      permissions.hasPermission.mockResolvedValue(false);
      await expect(service.statisticsFor(ROOM, ACTOR)).resolves.toEqual({ totalGifts: 5 });
      expect(statistics.breakdown).not.toHaveBeenCalled();
    });

    it('returns the breakdown for a VIEW_ANALYTICS holder', async () => {
      permissions.hasPermission.mockResolvedValue(true);
      await expect(service.statisticsFor(ROOM, ACTOR)).resolves.toMatchObject({
        uniqueSenders: 2,
      });
      expect(statistics.summary).not.toHaveBeenCalled();
    });

    it('checks VIEW_ANALYTICS against the resolved room ref', async () => {
      await service.statisticsFor(ROOM, ACTOR);
      expect(permissions.hasPermission).toHaveBeenCalledWith(
        ACTOR,
        { id: ROOM, ownerId: 'owner-1' },
        'VIEW_ANALYTICS',
      );
    });

    it('404s for a room that does not exist', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(service.statisticsFor(ROOM, ACTOR)).rejects.toMatchObject({
        errorCode: 'VIDEO_ROOM_NOT_FOUND',
      });
    });
  });
});
