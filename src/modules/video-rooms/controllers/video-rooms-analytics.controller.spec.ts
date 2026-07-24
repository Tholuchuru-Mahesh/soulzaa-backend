import { Test, TestingModule } from '@nestjs/testing';
import { VideoRoomsAnalyticsController } from './video-rooms-analytics.controller';
import { VideoRoomAnalyticsQueryService } from '../services/video-room-analytics-query.service';
import { VideoRoomAnalyticsPeriod } from '../enums/video-room-analytics.enum';

describe('VideoRoomsAnalyticsController', () => {
  let controller: VideoRoomsAnalyticsController;
  let queryServiceMock: any;

  beforeEach(async () => {
    queryServiceMock = {
      getRoomAnalytics: jest.fn().mockResolvedValue({ roomId: 'room-1', peakViewers: 100 }),
      getHostAnalytics: jest.fn().mockResolvedValue({ hostId: 'user-1', roomsHosted: 5 }),
      getViewerAnalytics: jest
        .fn()
        .mockResolvedValue({ viewerId: 'user-2', watchTimeSeconds: 3600 }),
      getGiftAnalytics: jest.fn().mockResolvedValue({ giftCount: 50, giftRevenue: 5000 }),
      getPKAnalytics: jest.fn().mockResolvedValue({ battlesStarted: 10, winRate: 0.8 }),
      getTreasureAnalytics: jest.fn().mockResolvedValue({ boxesCreated: 3, rewardPool: 1000 }),
      getEngagementAnalytics: jest.fn().mockResolvedValue({ activeRooms: 10, activeViewers: 100 }),
      getAnalyticsHistory: jest.fn().mockResolvedValue([{ metricKey: 'peak_viewers' }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VideoRoomsAnalyticsController],
      providers: [{ provide: VideoRoomAnalyticsQueryService, useValue: queryServiceMock }],
    }).compile();

    controller = module.get<VideoRoomsAnalyticsController>(VideoRoomsAnalyticsController);
  });

  const mockUser: any = { id: 'user-1', roles: [] };

  it('should get room analytics', async () => {
    const res = await controller.getRoomAnalytics(
      mockUser,
      '123e4567-e89b-12d3-a456-426614174000',
      {
        period: VideoRoomAnalyticsPeriod.TODAY,
      },
    );
    expect(res).toBeDefined();
    expect(queryServiceMock.getRoomAnalytics).toHaveBeenCalled();
  });

  it('should get host analytics', async () => {
    const res = await controller.getHostAnalytics(
      mockUser,
      '123e4567-e89b-12d3-a456-426614174000',
      {
        period: VideoRoomAnalyticsPeriod.TODAY,
      },
    );
    expect(res).toBeDefined();
    expect(queryServiceMock.getHostAnalytics).toHaveBeenCalled();
  });

  it('should get viewer analytics', async () => {
    const res = await controller.getViewerAnalytics(
      mockUser,
      '123e4567-e89b-12d3-a456-426614174000',
      {
        period: VideoRoomAnalyticsPeriod.TODAY,
      },
    );
    expect(res).toBeDefined();
    expect(queryServiceMock.getViewerAnalytics).toHaveBeenCalled();
  });

  it('should get gift analytics', async () => {
    const res = await controller.getGiftAnalytics(mockUser, {});
    expect(res).toBeDefined();
    expect(queryServiceMock.getGiftAnalytics).toHaveBeenCalled();
  });

  it('should get PK analytics', async () => {
    const res = await controller.getPKAnalytics(mockUser, {});
    expect(res).toBeDefined();
    expect(queryServiceMock.getPKAnalytics).toHaveBeenCalled();
  });

  it('should get treasure analytics', async () => {
    const res = await controller.getTreasureAnalytics(mockUser, {});
    expect(res).toBeDefined();
    expect(queryServiceMock.getTreasureAnalytics).toHaveBeenCalled();
  });

  it('should get engagement analytics', async () => {
    const res = await controller.getEngagementAnalytics(mockUser, {});
    expect(res).toBeDefined();
    expect(queryServiceMock.getEngagementAnalytics).toHaveBeenCalled();
  });

  it('should get analytics history', async () => {
    const res = await controller.getAnalyticsHistory(mockUser, {});
    expect(res).toBeDefined();
    expect(queryServiceMock.getAnalyticsHistory).toHaveBeenCalled();
  });
});
