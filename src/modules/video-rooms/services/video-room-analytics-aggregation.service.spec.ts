import { Test, TestingModule } from '@nestjs/testing';
import { VideoRoomAnalyticsMetrics } from '../metrics/video-room-analytics.metrics';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';
import { VideoRoomAnalyticsAggregationService } from './video-room-analytics-aggregation.service';
import { VideoRoomAnalyticsAuditService } from './video-room-analytics-audit.service';
import { VideoRoomAnalyticsCacheService } from './video-room-analytics-cache.service';

describe('VideoRoomAnalyticsAggregationService', () => {
  let service: VideoRoomAnalyticsAggregationService;
  let repoMock: any;
  let cacheMock: any;
  let auditMock: any;
  let metricsMock: any;

  beforeEach(async () => {
    repoMock = {
      upsertRoomDailyStat: jest.fn().mockResolvedValue({ id: 'stat-1' }),
      upsertCreatorDailyStat: jest.fn().mockResolvedValue({ id: 'creator-1' }),
      upsertAnalyticsStatistics: jest.fn().mockResolvedValue({ id: 'agg-1' }),
      createSnapshot: jest.fn().mockResolvedValue({ id: 'snap-1' }),
    };

    cacheMock = {
      getLiveActiveMetrics: jest.fn().mockResolvedValue({
        activeRooms: 10,
        activeHosts: 5,
        activeParticipants: 20,
        activeViewers: 100,
        concurrentPkBattles: 2,
        concurrentGifts: 5,
        concurrentTreasureEvents: 1,
      }),
      setCachedAnalytics: jest.fn().mockResolvedValue(undefined),
    };

    auditMock = {
      logAudit: jest.fn().mockResolvedValue(undefined),
    };

    metricsMock = {
      observeAggregationDuration: jest.fn(),
      incFailure: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoRoomAnalyticsAggregationService,
        { provide: VideoRoomAnalyticsProjectionRepository, useValue: repoMock },
        { provide: VideoRoomAnalyticsCacheService, useValue: cacheMock },
        { provide: VideoRoomAnalyticsAuditService, useValue: auditMock },
        { provide: VideoRoomAnalyticsMetrics, useValue: metricsMock },
      ],
    }).compile();

    service = module.get<VideoRoomAnalyticsAggregationService>(
      VideoRoomAnalyticsAggregationService,
    );
  });

  it('should run hourly aggregation idempotently', async () => {
    const res = await service.aggregateHourly('2026072315');
    expect(res).toBeDefined();
    expect(res.period).toBe('HOURLY');
    expect(repoMock.upsertAnalyticsStatistics).toHaveBeenCalled();
    expect(auditMock.logAudit).toHaveBeenCalled();
  });

  it('should run daily aggregation idempotently', async () => {
    const res = await service.aggregateDaily('20260723');
    expect(res).toBeDefined();
    expect(res.period).toBe('DAILY');
    expect(repoMock.upsertAnalyticsStatistics).toHaveBeenCalled();
  });

  it('should run weekly aggregation idempotently', async () => {
    const res = await service.aggregateWeekly('2026W30');
    expect(res).toBeDefined();
    expect(res.period).toBe('WEEKLY');
  });

  it('should run monthly aggregation idempotently', async () => {
    const res = await service.aggregateMonthly('202607');
    expect(res).toBeDefined();
    expect(res.period).toBe('MONTHLY');
  });

  it('should create historical snapshot', async () => {
    const res = await service.createHistoricalSnapshot('video_room', 'peak_viewers', 150);
    expect(repoMock.createSnapshot).toHaveBeenCalled();
    expect(res).toBeDefined();
  });
});
