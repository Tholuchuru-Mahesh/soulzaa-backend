import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomAnalyticsProjectionRepository } from './video-room-analytics-projection.repository';

describe('VideoRoomAnalyticsProjectionRepository', () => {
  let repository: VideoRoomAnalyticsProjectionRepository;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      roomDailyStat: {
        upsert: jest.fn().mockResolvedValue({ dateKey: '20260723', roomId: 'room-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      creatorDailyStat: {
        upsert: jest.fn().mockResolvedValue({ dateKey: '20260723', userId: 'user-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      analyticsStatistics: {
        upsert: jest.fn().mockResolvedValue({ period: 'HOURLY', dateKey: '20260723' }),
      },
      analyticsSnapshot: {
        create: jest.fn().mockResolvedValue({ id: 'snap-1', domain: 'video_room' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      analyticsAudit: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      videoRoomStatistics: {
        findUnique: jest.fn().mockResolvedValue({ roomId: 'room-1', peakViewers: 50 }),
        update: jest.fn().mockResolvedValue({ roomId: 'room-1', peakViewers: 60 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoRoomAnalyticsProjectionRepository,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    repository = module.get<VideoRoomAnalyticsProjectionRepository>(
      VideoRoomAnalyticsProjectionRepository,
    );
  });

  it('should upsert room daily stat', async () => {
    const res = await repository.upsertRoomDailyStat({
      dateKey: '20260723',
      roomId: 'room-1',
      joins: 5,
    });
    expect(prismaMock.roomDailyStat.upsert).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should upsert creator daily stat', async () => {
    const res = await repository.upsertCreatorDailyStat({
      dateKey: '20260723',
      userId: 'user-1',
      roomsHosted: 1,
    });
    expect(prismaMock.creatorDailyStat.upsert).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should get room statistics and daily stats', async () => {
    const stats = await repository.getRoomStatistics('room-1');
    expect(stats?.peakViewers).toBe(50);

    const daily = await repository.getRoomDailyStats('room-1');
    expect(daily).toEqual([]);
  });
});
