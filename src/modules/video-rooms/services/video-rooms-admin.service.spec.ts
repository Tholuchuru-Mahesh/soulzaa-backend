import { Test, TestingModule } from '@nestjs/testing';
import { VideoRoomsAdminService } from './video-rooms-admin.service';
import { VideoRoomSeatService } from './video-room-seat.service';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomsAdminRepository } from '../repositories/video-rooms-admin.repository';
import { VideoRoomModerationService } from './video-room-moderation.service';
import { VideoRoomReportService } from './video-room-report.service';
import { VideoRoomEventService } from './video-room-event.service';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { CacheService } from 'src/infra/redis/cache.service';
import { VideoRoomStatus } from '@prisma/client';

describe('VideoRoomsAdminService', () => {
  let service: VideoRoomsAdminService;
  let seatServiceMock: any;
  let roomsRepoMock: any;
  let adminRepoMock: any;
  let moderationServiceMock: any;
  let reportServiceMock: any;
  let eventServiceMock: any;
  let analyticsProjectionMock: any;
  let socketsMock: any;
  let cacheServiceMock: any;

  beforeEach(async () => {
    seatServiceMock = {
      leaveSeat: jest.fn().mockResolvedValue(undefined),
    };

    roomsRepoMock = {
      findById: jest.fn().mockResolvedValue({ id: 'room-1', ownerId: 'owner-1' }),
      softDelete: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      updateRoom: jest.fn().mockResolvedValue({ id: 'room-1' }),
      updateSettings: jest.fn().mockResolvedValue({ roomId: 'room-1', isChatMuted: true }),
    };

    adminRepoMock = {
      listRooms: jest.fn().mockResolvedValue({
        items: [{ id: 'room-1', status: VideoRoomStatus.LIVE, giftLockEnabled: false }],
        total: 1,
      }),
      getRoomDetail: jest.fn().mockResolvedValue({ id: 'room-1' }),
      createRoomLog: jest.fn().mockResolvedValue({ id: 'log-1' }),
    };

    moderationServiceMock = {
      blacklist: jest.fn().mockResolvedValue({ id: 'block-1' }),
      unblacklist: jest.fn().mockResolvedValue(undefined),
      mute: jest.fn().mockResolvedValue({ id: 'mute-1' }),
      unmute: jest.fn().mockResolvedValue(undefined),
    };

    reportServiceMock = {
      reviewReport: jest.fn().mockResolvedValue(undefined),
    };

    eventServiceMock = {
      emitRoomClosed: jest.fn().mockResolvedValue(undefined),
      emitRoomDeleted: jest.fn().mockResolvedValue(undefined),
    };

    analyticsProjectionMock = {
      getAnalyticsSnapshots: jest.fn().mockResolvedValue([
        {
          metrics: {
            totalViewers: 10,
            peakConcurrentViewers: 15,
            totalGiftsSent: 50,
          },
        },
      ]),
    };

    socketsMock = {
      emitToNamespaceRoom: jest.fn(),
    };

    cacheServiceMock = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoRoomsAdminService,
        { provide: VideoRoomSeatService, useValue: seatServiceMock },
        { provide: VideoRoomsRepository, useValue: roomsRepoMock },
        { provide: VideoRoomsAdminRepository, useValue: adminRepoMock },
        { provide: VideoRoomModerationService, useValue: moderationServiceMock },
        { provide: VideoRoomReportService, useValue: reportServiceMock },
        { provide: VideoRoomEventService, useValue: eventServiceMock },
        { provide: VideoRoomAnalyticsProjectionRepository, useValue: analyticsProjectionMock },
        { provide: SocketManager, useValue: socketsMock },
        { provide: CacheService, useValue: cacheServiceMock },
      ],
    }).compile();

    service = module.get<VideoRoomsAdminService>(VideoRoomsAdminService);
  });

  const actor = { id: 'admin-1', roles: ['ADMIN'] as any };

  it('should return operational dashboard overview', async () => {
    const res = await service.getDashboardOverview(actor);
    expect(res).toBeDefined();
    expect(adminRepoMock.listRooms).toHaveBeenCalled();
    expect(cacheServiceMock.set).toHaveBeenCalled();
  });

  it('should list rooms', async () => {
    const res = await service.listRooms(actor, { page: 1, limit: 20, skip: 0 });
    expect(adminRepoMock.listRooms).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should fetch room detail', async () => {
    const res = await service.getRoomDetail(actor, 'room-1');
    expect(adminRepoMock.getRoomDetail).toHaveBeenCalledWith('room-1');
    expect(res?.id).toBe('room-1');
  });

  it('should remove room permanently, emit event and socket message', async () => {
    await service.remove(actor, 'room-1');
    expect(roomsRepoMock.softDelete).toHaveBeenCalledWith('room-1', 'admin-1');
    expect(eventServiceMock.emitRoomDeleted).toHaveBeenCalled();
    expect(socketsMock.emitToNamespaceRoom).toHaveBeenCalled();
  });

  it('should end active room session, emit event and socket message', async () => {
    await service.end(actor, 'room-1');
    expect(roomsRepoMock.updateStatus).toHaveBeenCalled();
    expect(eventServiceMock.emitRoomClosed).toHaveBeenCalled();
    expect(socketsMock.emitToNamespaceRoom).toHaveBeenCalled();
  });
});
