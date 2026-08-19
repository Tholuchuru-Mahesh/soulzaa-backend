import { Test, TestingModule } from '@nestjs/testing';
import { VideoRoomsAdminController } from './video-rooms-admin.controller';
import { VideoRoomsAdminService } from '../services/video-rooms-admin.service';
import { VideoRoomsAdminRepository } from '../repositories/video-rooms-admin.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomReportRepository } from '../repositories/video-room-report.repository';
import { VideoRoomReportStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
describe('VideoRoomsAdminController', () => {
  let controller: VideoRoomsAdminController;
  let adminServiceMock: any;
  let adminRepoMock: any;
  let roomsRepoMock: any;
  let moderationRepoMock: any;
  let reportRepoMock: any;

  beforeEach(async () => {
    adminServiceMock = {
      getDashboardOverview: jest.fn().mockResolvedValue({ summary: {} }),
      listRooms: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getRoomDetail: jest.fn().mockResolvedValue({ id: 'room-1' }),
      remove: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      setLock: jest.fn().mockResolvedValue({ id: 'room-1', isLocked: true }),
      removeOwner: jest.fn().mockResolvedValue(undefined),
      removeParticipant: jest.fn().mockResolvedValue(undefined),
      disableChat: jest.fn().mockResolvedValue(undefined),
      banUser: jest.fn().mockResolvedValue(undefined),
      unbanUser: jest.fn().mockResolvedValue(undefined),
      muteUser: jest.fn().mockResolvedValue(undefined),
      unmuteUser: jest.fn().mockResolvedValue(undefined),
      reviewReport: jest.fn().mockResolvedValue(undefined),
    };

    adminRepoMock = {
      getRoomGiftTransactions: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getRoomLogs: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };

    roomsRepoMock = {
      listActiveMembers: jest.fn().mockResolvedValue([]),
    };

    moderationRepoMock = {
      listActiveBlocks: jest.fn().mockResolvedValue([[], 0]),
      listActiveMutes: jest.fn().mockResolvedValue([[], 0]),
      listActions: jest.fn().mockResolvedValue([[], 0]),
    };

    reportRepoMock = {
      list: jest.fn().mockResolvedValue([[], 0]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VideoRoomsAdminController],
      providers: [
        { provide: VideoRoomsAdminService, useValue: adminServiceMock },
        { provide: VideoRoomsAdminRepository, useValue: adminRepoMock },
        { provide: VideoRoomsRepository, useValue: roomsRepoMock },
        { provide: VideoRoomModerationRepository, useValue: moderationRepoMock },
        { provide: VideoRoomReportRepository, useValue: reportRepoMock },
        { provide: PrismaService, useValue: {} },
        { provide: MediaUrlResolver, useValue: { resolve: jest.fn() } },
      ],
    }).compile();

    controller = module.get<VideoRoomsAdminController>(VideoRoomsAdminController);
  });

  const user = { id: 'admin-1', roles: ['ADMIN'] as any };

  it('should return operational dashboard overview', async () => {
    const res = await controller.getDashboardOverview(user);
    expect(adminServiceMock.getDashboardOverview).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should list rooms for administration', async () => {
    const res = await controller.listRooms(user, { page: 1, limit: 20, skip: 0 });
    expect(adminServiceMock.listRooms).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should get room detail for administration', async () => {
    const res = await controller.getRoomDetail(user, '123e4567-e89b-12d3-a456-426614174000');
    expect(adminServiceMock.getRoomDetail).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should remove room permanently', async () => {
    await controller.remove(user, '123e4567-e89b-12d3-a456-426614174000');
    expect(adminServiceMock.remove).toHaveBeenCalled();
  });

  it('should end room session', async () => {
    const res = await controller.end(user, '123e4567-e89b-12d3-a456-426614174000');
    expect(adminServiceMock.end).toHaveBeenCalled();
    expect(res.ended).toBe(true);
  });

  it('should lock room', async () => {
    const res = await controller.lock(user, '123e4567-e89b-12d3-a456-426614174000', {
      isLocked: true,
    });
    expect(adminServiceMock.setLock).toHaveBeenCalled();
    expect(res).toBeDefined();
  });

  it('should ban user', async () => {
    const res = await controller.banUser(
      user,
      '123e4567-e89b-12d3-a456-426614174000',
      '123e4567-e89b-12d3-a456-426614174001',
      { reason: 'Violations' },
    );
    expect(adminServiceMock.banUser).toHaveBeenCalled();
    expect(res.banned).toBe(true);
  });

  it('should unban user', async () => {
    const res = await controller.unbanUser(
      user,
      '123e4567-e89b-12d3-a456-426614174000',
      '123e4567-e89b-12d3-a456-426614174001',
    );
    expect(adminServiceMock.unbanUser).toHaveBeenCalled();
    expect(res.unbanned).toBe(true);
  });

  it('should review report', async () => {
    const res = await controller.reviewReport(
      user,
      '123e4567-e89b-12d3-a456-426614174000',
      '123e4567-e89b-12d3-a456-426614174002',
      { status: VideoRoomReportStatus.REVIEWED, note: 'Done' },
    );
    expect(adminServiceMock.reviewReport).toHaveBeenCalled();
    expect(res.reportReviewed).toBe(true);
  });
});
