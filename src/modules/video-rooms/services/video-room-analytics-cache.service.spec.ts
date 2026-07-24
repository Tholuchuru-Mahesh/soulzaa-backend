import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from 'src/infra/redis/redis.constants';
import { VideoRoomAnalyticsCacheService } from './video-room-analytics-cache.service';

describe('VideoRoomAnalyticsCacheService', () => {
  let service: VideoRoomAnalyticsCacheService;
  let redisMock: any;
  let configMock: any;

  beforeEach(async () => {
    redisMock = {
      incr: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue('10'),
      set: jest.fn().mockResolvedValue('OK'),
      setex: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      scard: jest.fn().mockResolvedValue(5),
    };

    configMock = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoRoomAnalyticsCacheService,
        { provide: REDIS_CLIENT, useValue: redisMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<VideoRoomAnalyticsCacheService>(VideoRoomAnalyticsCacheService);
  });

  it('should increment and decrement active rooms counter', async () => {
    await service.incrementActiveRooms('room-1');
    expect(redisMock.sadd).toHaveBeenCalled();

    await service.decrementActiveRooms('room-1');
    expect(redisMock.srem).toHaveBeenCalled();
  });

  it('should get active counters metrics', async () => {
    const metrics = await service.getLiveActiveMetrics();
    expect(metrics).toBeDefined();
    expect(metrics.activeRooms).toBe(5);
  });

  it('should set and get analytics cache', async () => {
    const data = { roomId: 'room-1', peakViewers: 100 };
    await service.setCachedAnalytics('room-1', 'TODAY', data);
    expect(redisMock.setex).toHaveBeenCalled();

    redisMock.get.mockResolvedValueOnce(JSON.stringify(data));
    const cached = await service.getCachedAnalytics('room-1', 'TODAY');
    expect(cached).toEqual(data);
  });

  it('should invalidate analytics cache', async () => {
    await service.invalidateAnalyticsCache('room-1', 'TODAY');
    expect(redisMock.del).toHaveBeenCalled();
  });
});
