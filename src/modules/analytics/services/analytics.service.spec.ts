import { BusinessException } from 'src/common/exceptions';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { AnalyticsService, GLOBAL_ANALYTICS_UUID } from './analytics.service';

describe('AnalyticsService', () => {
  let repo: Record<string, jest.Mock>;
  let service: AnalyticsService;

  beforeEach(() => {
    repo = {
      findRoomActivity: jest.fn().mockResolvedValue({
        roomId: 'room-1',
        peakParticipants: 10,
        totalJoined: 15,
        totalGifts: 25,
        totalGiftCoins: 5000n,
        totalSpeakingMinutes: 45,
        durationSeconds: 3600,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getSpeakingDurationsGrouped: jest
        .fn()
        .mockResolvedValue([[{ userId: 'user-1', _sum: { speakingSeconds: 120 } }], 1]),
      listVisitors: jest.fn().mockResolvedValue([
        [
          {
            userId: 'user-1',
            joinedAt: new Date(Date.now() - 60000),
            leftAt: new Date(),
            durationSeconds: 60,
          },
        ],
        1,
      ]),
      getRevenueReports: jest.fn().mockResolvedValue([
        {
          dateKey: '20260707',
          roomId: GLOBAL_ANALYTICS_UUID,
          userId: GLOBAL_ANALYTICS_UUID,
          giftCoins: 5000n,
          creatorCoins: 2500n,
        },
      ]),
      getUsersDetails: jest.fn().mockResolvedValue([{ id: 'user-1', username: 'gamer1' }]),
      getUserProfiles: jest.fn().mockResolvedValue([{ userId: 'user-1', avatarKey: 'avatar-1' }]),
      getAverageVisitorDuration: jest.fn().mockResolvedValue(60),
    };

    const prisma = {
      giftTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalCoinValue: 0n }, _count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      roomVisitor: {
        aggregate: jest.fn().mockResolvedValue({ _count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      speakerSession: { aggregate: jest.fn().mockResolvedValue({ _sum: { speakingSeconds: 0 } }) },
      audioRoom: { findUnique: jest.fn().mockResolvedValue(null) },
      videoRoom: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    service = new AnalyticsService(repo as unknown as AnalyticsRepository, prisma as any);
  });

  describe('getRoomActivity', () => {
    it('returns formatted room activity stats', async () => {
      const res = await service.getRoomActivity('room-1');
      expect(repo.findRoomActivity).toHaveBeenCalledWith('room-1');
      expect(res.roomId).toBe('room-1');
      expect(res.totalGiftCoins).toBe('5000');
    });

    it('throws NOT_FOUND if room activity not recorded', async () => {
      repo.findRoomActivity.mockResolvedValue(null);
      await expect(service.getRoomActivity('room-1')).rejects.toThrow(
        new BusinessException('NOT_FOUND', 'No activity records found for this room.'),
      );
    });
  });

  describe('getSpeakingDurations', () => {
    it('returns speaking list with usernames and avatars', async () => {
      const res = await service.getSpeakingDurations('room-1', 0, 50, 1);
      expect(repo.getSpeakingDurationsGrouped).toHaveBeenCalledWith('room-1', 0, 50);
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toEqual({
        userId: 'user-1',
        username: 'gamer1',
        avatarKey: 'avatar-1',
        speakingSeconds: 120,
      });
    });
  });

  describe('getAttendance', () => {
    it('returns attendance logs with profiles', async () => {
      const res = await service.getAttendance('room-1', 0, 50, 1);
      expect(repo.listVisitors).toHaveBeenCalledWith('room-1', 0, 50);
      expect(res.items).toHaveLength(1);
      expect(res.items[0].username).toBe('gamer1');
      expect(res.items[0].durationSeconds).toBe(60);
    });
  });

  describe('getEngagement', () => {
    it('calculates average stay, speaking ratio and gift intensities', async () => {
      const res = await service.getEngagement('room-1');
      expect(repo.findRoomActivity).toHaveBeenCalledWith('room-1');
      expect(repo.getAverageVisitorDuration).toHaveBeenCalledWith('room-1');
      expect(repo.getSpeakingDurationsGrouped).toHaveBeenCalledWith('room-1', 0, 100000);
      expect(res).toEqual({
        roomId: 'room-1',
        averageStayDurationSeconds: 60,
        speakingToViewerRatio: 6.67, // 1 speaker / 15 joins * 100
        giftIntensity: 1.67, // 25 gifts / 15 joins
        coinIntensity: 333.33, // 5000 coins / 15 joins
      });
    });
  });

  describe('getRevenue', () => {
    it('returns revenue reports formatted', async () => {
      const res = await service.getRevenue({ startDate: '20260701', endDate: '20260707' });
      expect(repo.getRevenueReports).toHaveBeenCalledWith({
        startDate: '20260701',
        endDate: '20260707',
        roomId: GLOBAL_ANALYTICS_UUID,
        userId: GLOBAL_ANALYTICS_UUID,
      });
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({
        dateKey: '20260707',
        roomId: GLOBAL_ANALYTICS_UUID,
        userId: GLOBAL_ANALYTICS_UUID,
        giftCoins: '5000',
        creatorCoins: '2500',
      });
    });
  });
});
