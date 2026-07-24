import { Test, TestingModule } from '@nestjs/testing';
import { VideoRoomAnalyticsPeriod } from '../enums/video-room-analytics.enum';
import { AnalyticsException } from '../exceptions/video-room-analytics.exception';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomAnalyticsCacheService } from './video-room-analytics-cache.service';
import { VideoRoomAnalyticsQueryService } from './video-room-analytics-query.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

describe('VideoRoomAnalyticsQueryService', () => {
  let service: VideoRoomAnalyticsQueryService;
  let repoMock: any;
  let cacheMock: any;
  let permMock: any;
  let roomsRepoMock: any;

  beforeEach(async () => {
    repoMock = {
      getRoomDailyStats: jest.fn().mockResolvedValue([{ dateKey: '20260723', joins: 10 }]),
      getCreatorDailyStats: jest
        .fn()
        .mockResolvedValue([{ dateKey: '20260723', giftsReceivedCount: 5 }]),
      getAnalyticsSnapshots: jest
        .fn()
        .mockResolvedValue([{ metricKey: 'peak_viewers', metricValue: 100 }]),
      getRoomStatistics: jest.fn().mockResolvedValue({
        roomId: 'room-1',
        peakViewers: 100,
        peakParticipants: 10,
        currentViewers: 20,
        totalDurationSeconds: BigInt(3600),
      }),
    };

    cacheMock = {
      getCachedAnalytics: jest.fn().mockResolvedValue(null),
      setCachedAnalytics: jest.fn().mockResolvedValue(undefined),
      getLiveActiveMetrics: jest.fn().mockResolvedValue({
        activeRooms: 10,
        activeHosts: 5,
        activeParticipants: 20,
        activeViewers: 100,
        concurrentPkBattles: 2,
        concurrentGifts: 5,
        concurrentTreasureEvents: 1,
      }),
    };

    permMock = {
      hasPermission: jest.fn().mockResolvedValue(true),
    };

    roomsRepoMock = {
      findById: jest.fn().mockResolvedValue({ id: 'room-1', ownerId: 'user-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoRoomAnalyticsQueryService,
        { provide: VideoRoomAnalyticsProjectionRepository, useValue: repoMock },
        { provide: VideoRoomAnalyticsCacheService, useValue: cacheMock },
        { provide: VideoRoomPermissionService, useValue: permMock },
        { provide: VideoRoomsRepository, useValue: roomsRepoMock },
      ],
    }).compile();

    service = module.get<VideoRoomAnalyticsQueryService>(VideoRoomAnalyticsQueryService);
  });

  it('should return room analytics when permission granted', async () => {
    const actor = { id: 'user-1', roles: [] as any };
    const res = await service.getRoomAnalytics('room-1', actor, VideoRoomAnalyticsPeriod.TODAY);
    expect(res).toBeDefined();
    expect(res.roomId).toBe('room-1');
  });

  it('should throw AnalyticsException when permission denied', async () => {
    permMock.hasPermission.mockResolvedValueOnce(false);
    const actor = { id: 'user-2', roles: [] as any };
    await expect(
      service.getRoomAnalytics('room-1', actor, VideoRoomAnalyticsPeriod.TODAY),
    ).rejects.toThrow(AnalyticsException);
  });

  it('should return host analytics for own profile', async () => {
    const actor = { id: 'user-1', roles: [] as any };
    const res = await service.getHostAnalytics('user-1', actor);
    expect(res).toBeDefined();
    expect(res.hostId).toBe('user-1');
  });

  it('should return viewer analytics for own profile', async () => {
    const actor = { id: 'user-1', roles: [] as any };
    const res = await service.getViewerAnalytics('user-1', actor);
    expect(res).toBeDefined();
    expect(res.viewerId).toBe('user-1');
  });

  it('should return gift analytics summary', async () => {
    const actor = { id: 'user-1', roles: [] as any };
    const res = await service.getGiftAnalytics(actor);
    expect(res).toBeDefined();
  });
});
