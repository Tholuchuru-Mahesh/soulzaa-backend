import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  QueryAnalyticsDto,
  RoomAnalyticsDto,
  HostAnalyticsDto,
  ViewerAnalyticsDto,
  GiftAnalyticsDto,
  PKAnalyticsDto,
  TreasureAnalyticsDto,
  AnalyticsResponseDto,
} from './video-room-analytics.dto';
import { VideoRoomAnalyticsPeriod } from '../enums/video-room-analytics.enum';
import {
  AnalyticsException,
  AggregationException,
  AnalyticsCacheException,
  AnalyticsSnapshotException,
} from '../exceptions/video-room-analytics.exception';

describe('VideoRoomAnalytics DTOs & Exceptions', () => {
  describe('QueryAnalyticsDto', () => {
    it('should validate valid period query', async () => {
      const dto = plainToInstance(QueryAnalyticsDto, {
        period: VideoRoomAnalyticsPeriod.TODAY,
        limit: 10,
        page: 1,
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should fail invalid period', async () => {
      const dto = plainToInstance(QueryAnalyticsDto, {
        period: 'INVALID_PERIOD',
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('Custom Exceptions', () => {
    it('should create AnalyticsException', () => {
      const ex = new AnalyticsException('Analytics error');
      expect(ex.message).toBe('Analytics error');
    });

    it('should create AggregationException', () => {
      const ex = new AggregationException('Aggregation error');
      expect(ex.message).toBe('Aggregation error');
    });

    it('should create AnalyticsCacheException', () => {
      const ex = new AnalyticsCacheException('Cache error');
      expect(ex.message).toBe('Cache error');
    });

    it('should create AnalyticsSnapshotException', () => {
      const ex = new AnalyticsSnapshotException('Snapshot error');
      expect(ex.message).toBe('Snapshot error');
    });
  });

  describe('Analytics DTOs instantiation', () => {
    it('should instantiate RoomAnalyticsDto correctly', () => {
      const dto = new RoomAnalyticsDto();
      dto.roomId = '123e4567-e89b-12d3-a456-426614174000';
      dto.peakViewers = 100;
      dto.peakParticipants = 10;
      expect(dto.peakViewers).toBe(100);
    });

    it('should instantiate HostAnalyticsDto correctly', () => {
      const dto = new HostAnalyticsDto();
      dto.hostId = '123e4567-e89b-12d3-a456-426614174000';
      dto.roomsHosted = 5;
      expect(dto.roomsHosted).toBe(5);
    });

    it('should instantiate ViewerAnalyticsDto correctly', () => {
      const dto = new ViewerAnalyticsDto();
      dto.viewerId = '123e4567-e89b-12d3-a456-426614174000';
      dto.viewerSessions = 12;
      expect(dto.viewerSessions).toBe(12);
    });

    it('should instantiate GiftAnalyticsDto correctly', () => {
      const dto = new GiftAnalyticsDto();
      dto.giftCount = 50;
      dto.giftRevenue = 5000;
      expect(dto.giftRevenue).toBe(5000);
    });

    it('should instantiate PKAnalyticsDto correctly', () => {
      const dto = new PKAnalyticsDto();
      dto.battlesStarted = 10;
      dto.winRate = 0.8;
      expect(dto.winRate).toBe(0.8);
    });

    it('should instantiate TreasureAnalyticsDto correctly', () => {
      const dto = new TreasureAnalyticsDto();
      dto.boxesCreated = 3;
      dto.rewardPool = 1000;
      expect(dto.rewardPool).toBe(1000);
    });

    it('should instantiate AnalyticsResponseDto correctly', () => {
      const dto = new AnalyticsResponseDto();
      dto.success = true;
      dto.data = { metric: 'test' };
      expect(dto.success).toBe(true);
    });
  });
});
