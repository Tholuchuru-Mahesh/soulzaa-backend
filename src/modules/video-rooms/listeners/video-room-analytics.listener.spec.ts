import { Test, TestingModule } from '@nestjs/testing';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';
import { VideoRoomAnalyticsCacheService } from '../services/video-room-analytics-cache.service';
import { VideoRoomAnalyticsListener } from './video-room-analytics.listener';

describe('VideoRoomAnalyticsListener', () => {
  let listener: VideoRoomAnalyticsListener;
  let cacheMock: any;
  let repoMock: any;

  beforeEach(async () => {
    cacheMock = {
      incrementActiveRooms: jest.fn().mockResolvedValue(undefined),
      decrementActiveRooms: jest.fn().mockResolvedValue(undefined),
      incrementActiveHosts: jest.fn().mockResolvedValue(undefined),
      decrementActiveHosts: jest.fn().mockResolvedValue(undefined),
      trackActiveParticipant: jest.fn().mockResolvedValue(undefined),
      untrackActiveParticipant: jest.fn().mockResolvedValue(undefined),
      trackActiveViewer: jest.fn().mockResolvedValue(undefined),
      untrackActiveViewer: jest.fn().mockResolvedValue(undefined),
    };

    repoMock = {
      upsertRoomDailyStat: jest.fn().mockResolvedValue({ id: 'stat-1' }),
      upsertCreatorDailyStat: jest.fn().mockResolvedValue({ id: 'creator-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoRoomAnalyticsListener,
        { provide: VideoRoomAnalyticsCacheService, useValue: cacheMock },
        { provide: VideoRoomAnalyticsProjectionRepository, useValue: repoMock },
      ],
    }).compile();

    listener = module.get<VideoRoomAnalyticsListener>(VideoRoomAnalyticsListener);
  });

  it('should handle room created event', async () => {
    await listener.handleRoomCreated({ payload: { roomId: 'room-1', ownerId: 'user-1' } } as any);
    expect(cacheMock.incrementActiveRooms).toHaveBeenCalledWith('room-1');
  });

  it('should handle room closed event', async () => {
    await listener.handleRoomClosed({ payload: { roomId: 'room-1', ownerId: 'user-1', durationSeconds: 3600 } } as any);
    expect(cacheMock.decrementActiveRooms).toHaveBeenCalledWith('room-1');
  });

  it('should handle user joined event', async () => {
    await listener.handleUserJoined({ payload: { roomId: 'room-1', userId: 'user-2', participantCount: 5 } } as any);
    expect(cacheMock.trackActiveParticipant).toHaveBeenCalledWith('user-2');
    expect(repoMock.upsertRoomDailyStat).toHaveBeenCalled();
  });

  it('should handle user left event', async () => {
    await listener.handleUserLeft({ payload: { roomId: 'room-1', userId: 'user-2', participantCount: 4 } } as any);
    expect(cacheMock.untrackActiveParticipant).toHaveBeenCalledWith('user-2');
  });
});
