import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomAnalyticsRepository } from './video-room-analytics.repository';

describe('VideoRoomAnalyticsRepository', () => {
  let repository: VideoRoomAnalyticsRepository;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      roomDailyStat: {
        upsert: jest.fn().mockResolvedValue({ id: 'stat-1', roomId: 'room-1' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'stat-1' }]),
      },
      creatorDailyStat: {
        upsert: jest.fn().mockResolvedValue({ id: 'creator-1', userId: 'user-1' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'creator-1' }]),
      },
      analyticsSnapshot: {
        create: jest.fn().mockResolvedValue({ id: 'snap-1', domain: 'video_room' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'snap-1' }]),
      },
      analyticsStatistics: {
        upsert: jest.fn().mockResolvedValue({ id: 'agg-1', period: 'DAILY' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'agg-1' }]),
      },
      analyticsAudit: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1', action: 'AGGREGATION' }),
      },
      videoRoomStatistics: {
        findUnique: jest.fn().mockResolvedValue({ roomId: 'room-1', peakViewers: 50 }),
        update: jest.fn().mockResolvedValue({ roomId: 'room-1', peakViewers: 100 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [VideoRoomAnalyticsRepository, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    repository = module.get<VideoRoomAnalyticsRepository>(VideoRoomAnalyticsRepository);
  });

  it('should upsert room daily stats', async () => {
    const res = await repository.upsertRoomDailyStat({
      dateKey: '20260723',
      roomId: 'room-1',
      joins: 10,
      uniqueVisitors: 8,
      peakParticipants: 5,
      messages: 100,
      giftCount: 20,
      giftCoins: BigInt(500),
      speakingSeconds: BigInt(1200),
    });

    expect(prismaMock.roomDailyStat.upsert).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should upsert creator daily stats', async () => {
    const res = await repository.upsertCreatorDailyStat({
      dateKey: '20260723',
      userId: 'user-1',
      giftsReceivedCount: 15,
      giftCoinsReceived: BigInt(300),
      creatorEarnings: BigInt(210),
      roomsHosted: 2,
      speakingSeconds: BigInt(3600),
    });

    expect(prismaMock.creatorDailyStat.upsert).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should create analytics snapshot', async () => {
    const res = await repository.createSnapshot({
      domain: 'video_room',
      metricKey: 'peak_viewers',
      metricValue: 150,
    });

    expect(prismaMock.analyticsSnapshot.create).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should create audit record', async () => {
    const res = await repository.createAudit({
      action: 'AGGREGATION',
      actorId: 'user-1',
      details: { roomId: 'room-1' },
    });

    expect(prismaMock.analyticsAudit.create).toHaveBeenCalled();
    expect(res).toBeDefined();
  });
});
