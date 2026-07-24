import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_BUS } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VideoRoomAnalyticsSocketListener } from './video-room-analytics-socket.listener';

describe('VideoRoomAnalyticsSocketListener', () => {
  let listener: VideoRoomAnalyticsSocketListener;
  let busMock: any;
  let socketManagerMock: any;

  beforeEach(async () => {
    busMock = {
      subscribe: jest.fn(),
    };

    socketManagerMock = {
      emitToNamespaceRoom: jest.fn(),
      emitToNamespace: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoRoomAnalyticsSocketListener,
        { provide: EVENT_BUS, useValue: busMock },
        { provide: SocketManager, useValue: socketManagerMock },
      ],
    }).compile();

    listener = module.get<VideoRoomAnalyticsSocketListener>(VideoRoomAnalyticsSocketListener);
  });

  it('should subscribe to analytics events on module init', () => {
    listener.onModuleInit();
    expect(busMock.subscribe).toHaveBeenCalledWith(
      'video_room.analytics_updated',
      expect.any(Function),
    );
  });
});
