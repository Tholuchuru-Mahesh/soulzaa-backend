import { AnalyticsRepository } from '../repositories/analytics.repository';
import { AnalyticsCountersService } from './analytics-counters.service';
import { AnalyticsReportingService, type AnalyticsActor } from './analytics-reporting.service';
import { AnalyticsRollupService } from './analytics-rollup.service';

const ROOM = 'room-1';
const OWNER: AnalyticsActor = { id: 'owner-1', roles: ['USER'] };
const ADMIN: AnalyticsActor = { id: 'admin-1', roles: ['ADMIN'] };
const STRANGER: AnalyticsActor = { id: 'stranger-1', roles: ['USER'] };

describe('AnalyticsReportingService', () => {
  let repo: Record<string, jest.Mock>;
  let counters: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let rollup: AnalyticsRollupService;
  let service: AnalyticsReportingService;

  beforeEach(() => {
    repo = {
      findRoomActivity: jest.fn().mockResolvedValue({
        roomId: ROOM,
        peakParticipants: 5,
        totalJoined: 10,
        totalGifts: 3,
        totalGiftCoins: 1500n,
        totalSpeakingMinutes: 20,
        durationSeconds: 600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      listRoomDailyStats: jest.fn().mockResolvedValue([
        {
          dateKey: '20260706',
          joins: 8,
          uniqueVisitors: 6,
          peakParticipants: 4,
          messages: 12,
          giftCount: 2,
          giftCoins: 800n,
          speakingSeconds: 300n,
          engagementScore: 40,
        },
      ]),
      listCreatorDailyStats: jest.fn().mockResolvedValue([
        {
          dateKey: '20260706',
          giftsReceivedCount: 4,
          giftCoinsReceived: 900n,
          creatorEarnings: 450n,
          roomsHosted: 1,
          speakingSeconds: 300n,
          engagementScore: 30,
        },
      ]),
      sumCreatorDailyStats: jest.fn().mockResolvedValue({
        giftsReceivedCount: 4,
        giftCoinsReceived: 900n,
        creatorEarnings: 450n,
        roomsHosted: 1,
        speakingSeconds: 7200n,
      }),
      getRevenueReports: jest.fn().mockResolvedValue([{ giftCoins: 1500n, creatorCoins: 750n }]),
    };
    counters = {
      readRoom: jest.fn().mockResolvedValue({
        joins: 2,
        messages: 5,
        giftCount: 1,
        giftCoins: 300,
        speakingSeconds: 120,
        uniqueVisitors: 2,
        peakParticipants: 3,
      }),
      readCreator: jest.fn().mockResolvedValue({
        giftsReceivedCount: 1,
        giftCoinsReceived: 300,
        creatorEarnings: 150,
        roomsHosted: 1,
        speakingSeconds: 120,
      }),
    };
    rooms = { getEffectiveRole: jest.fn().mockResolvedValue('OWNER') };
    rollup = new AnalyticsRollupService(
      repo as unknown as AnalyticsRepository,
      counters as unknown as AnalyticsCountersService,
    );
    const prisma = {
      giftTransaction: { aggregate: jest.fn().mockResolvedValue({ _sum: { creatorEarnings: 0n, totalCoinValue: 0n }, _count: 0 }) },
      ledgerEntry: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }) },
    };
    service = new AnalyticsReportingService(
      repo as unknown as AnalyticsRepository,
      counters as unknown as AnalyticsCountersService,
      rollup,
      rooms as never,
      prisma as never,
    );
  });

  describe('getRoomReport', () => {
    it('returns cumulative + today + revenue + series for a room owner', async () => {
      const res = await service.getRoomReport(OWNER, ROOM, 30);
      expect(res.roomId).toBe(ROOM);
      expect(res.activity?.totalGiftCoins).toBe('1500');
      expect(res.today.joins).toBe(2);
      expect(res.today.engagementScore).toBeGreaterThan(0);
      expect(res.revenue).toEqual({ giftCoins: '1500', creatorCoins: '750' });
      expect(res.dailySeries).toHaveLength(1);
      expect(res.dailySeries[0].giftCoins).toBe('800');
    });

    it('allows a platform admin without a room role', async () => {
      rooms.getEffectiveRole.mockResolvedValue(null);
      await expect(service.getRoomReport(ADMIN, ROOM, 30)).resolves.toBeDefined();
    });

    it('rejects a non-manager', async () => {
      rooms.getEffectiveRole.mockResolvedValue('LISTENER');
      await expect(service.getRoomReport(STRANGER, ROOM, 30)).rejects.toMatchObject({
        errorCode: 'ANALYTICS_NOT_AUTHORIZED',
      });
    });
  });

  describe('getMyAnalytics', () => {
    it('returns today, lifetime totals, revenue and series', async () => {
      const res = await service.getMyAnalytics(OWNER.id, 30);
      expect(res.userId).toBe(OWNER.id);
      expect(res.today.giftCoinsReceived).toBe(300);
      expect(res.totals.creatorEarnings).toBe('450');
      expect(res.totals.audioHours).toBe(2); // 7200s / 3600
      expect(res.revenue).toEqual({ giftCoins: '1500', creatorCoins: '750' });
      expect(res.dailySeries[0].creatorEarnings).toBe('450');
    });
  });
});

describe('AnalyticsRollupService', () => {
  let repo: Record<string, jest.Mock>;
  let counters: Record<string, jest.Mock>;
  let rollup: AnalyticsRollupService;

  beforeEach(() => {
    repo = {
      upsertRoomDailyStat: jest.fn().mockResolvedValue(undefined),
      upsertCreatorDailyStat: jest.fn().mockResolvedValue(undefined),
    };
    counters = {
      listActiveRooms: jest.fn().mockResolvedValue([ROOM]),
      listActiveCreators: jest.fn().mockResolvedValue([OWNER.id]),
      readRoom: jest.fn().mockResolvedValue({
        joins: 10,
        messages: 20,
        giftCount: 3,
        giftCoins: 900,
        speakingSeconds: 600,
        uniqueVisitors: 8,
        peakParticipants: 5,
      }),
      readCreator: jest.fn().mockResolvedValue({
        giftsReceivedCount: 3,
        giftCoinsReceived: 900,
        creatorEarnings: 450,
        roomsHosted: 1,
        speakingSeconds: 600,
      }),
      incrRoom: jest.fn().mockResolvedValue(undefined),
    };
    rollup = new AnalyticsRollupService(
      repo as unknown as AnalyticsRepository,
      counters as unknown as AnalyticsCountersService,
    );
  });

  it('materializes room + creator daily stats with an engagement score', async () => {
    const res = await rollup.runDailyRollup('20260706');
    expect(res).toEqual({ rooms: 1, creators: 1 });
    // room engagement = 10*1 + 20*1 + 3*5 + (600/60)*2 = 65
    expect(repo.upsertRoomDailyStat).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, giftCoins: 900n, engagementScore: 65 }),
    );
    // creator engagement = 1*1 + 3*5 + (600/60)*2 = 36
    expect(repo.upsertCreatorDailyStat).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER.id, creatorEarnings: 450n, engagementScore: 36 }),
    );
  });

  it('records a chat message toward the room counters', async () => {
    await rollup.recordChatMessage(ROOM);
    expect(counters.incrRoom).toHaveBeenCalledWith(ROOM, expect.any(String), 'messages', 1);
  });
});
