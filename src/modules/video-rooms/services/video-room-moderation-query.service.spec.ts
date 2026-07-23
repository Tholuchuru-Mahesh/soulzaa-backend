import { HttpStatus } from '@nestjs/common';
import { PlatformRole } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions';
import type { ListModerationDto } from '../dto/moderation.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationQueryService } from './video-room-moderation-query.service';

const ROOM = { id: 'room-1', ownerId: 'owner-1' };
const ELEVATED: RoomActor = { id: 'mod-1', roles: [] as PlatformRole[] };
const PLAIN: RoomActor = { id: 'member-1', roles: [] as PlatformRole[] };

function query(overrides: Partial<ListModerationDto> = {}): ListModerationDto {
  return { page: 1, limit: 20, skip: 0, ...overrides } as ListModerationDto;
}

describe('VideoRoomModerationQueryService', () => {
  let moderationRepo: any;
  let warningRepo: any;
  let rooms: any;
  let permissions: any;
  let subject: VideoRoomModerationQueryService;

  beforeEach(() => {
    moderationRepo = {
      listActions: jest.fn().mockResolvedValue([[{ id: 'a1' }], 1]),
      listActiveMutes: jest.fn().mockResolvedValue([[{ id: 'm1' }], 1]),
      listActiveBlocks: jest.fn().mockResolvedValue([[{ id: 'b1' }], 1]),
    };
    warningRepo = {
      list: jest.fn().mockResolvedValue([[{ id: 'w1' }], 1]),
    };
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
    };
    permissions = {
      hasAnyPermission: jest
        .fn()
        .mockImplementation((actor: RoomActor) => Promise.resolve(actor.id === ELEVATED.id)),
    };
    subject = new VideoRoomModerationQueryService(moderationRepo, warningRepo, rooms, permissions);
  });

  describe('elevated-permission gate', () => {
    it('history throws VIDEO_ROOM_FORBIDDEN for a non-elevated actor', async () => {
      await expect(subject.history(PLAIN, ROOM.id, query())).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
      });
      expect(moderationRepo.listActions).not.toHaveBeenCalled();
    });

    it('mutedUsers throws VIDEO_ROOM_FORBIDDEN for a non-elevated actor', async () => {
      await expect(subject.mutedUsers(PLAIN, ROOM.id, query())).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
      expect(moderationRepo.listActiveMutes).not.toHaveBeenCalled();
    });

    it('blacklistedUsers throws VIDEO_ROOM_FORBIDDEN for a non-elevated actor', async () => {
      await expect(subject.blacklistedUsers(PLAIN, ROOM.id, query())).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
      expect(moderationRepo.listActiveBlocks).not.toHaveBeenCalled();
    });

    it('warnings throws VIDEO_ROOM_FORBIDDEN for a non-elevated actor', async () => {
      await expect(subject.warnings(PLAIN, ROOM.id, query())).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
      expect(warningRepo.list).not.toHaveBeenCalled();
    });

    it('throws VIDEO_ROOM_NOT_FOUND when the room does not exist, before checking permission', async () => {
      rooms.findById.mockResolvedValueOnce(null);
      await expect(subject.history(ELEVATED, 'missing-room', query())).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
      expect(permissions.hasAnyPermission).not.toHaveBeenCalled();
    });

    it('checks KICK_USERS/BLOCK_USERS/MUTE_USERS together (elevated read = any of the three)', async () => {
      await subject.history(ELEVATED, ROOM.id, query());
      const permsChecked = permissions.hasAnyPermission.mock.calls[0][2];
      expect(permsChecked).toEqual(
        expect.arrayContaining(['KICK_USERS', 'BLOCK_USERS', 'MUTE_USERS']),
      );
    });
  });

  describe('paginated shape', () => {
    it('history returns the canonical Paginated<T> envelope, filtered by targetUserId', async () => {
      const result = await subject.history(ELEVATED, ROOM.id, query({ targetUserId: 'u9' }));
      expect(moderationRepo.listActions).toHaveBeenCalledWith(ROOM.id, 0, 20, 'u9');
      expect(result).toEqual({
        items: [{ id: 'a1' }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('mutedUsers returns the canonical Paginated<T> envelope, filtered by userId', async () => {
      const result = await subject.mutedUsers(ELEVATED, ROOM.id, query({ userId: 'u9' }));
      expect(moderationRepo.listActiveMutes).toHaveBeenCalledWith(ROOM.id, 0, 20, 'u9');
      expect(result).toEqual({
        items: [{ id: 'm1' }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('blacklistedUsers returns the canonical Paginated<T> envelope, filtered by userId', async () => {
      const result = await subject.blacklistedUsers(ELEVATED, ROOM.id, query({ userId: 'u9' }));
      expect(moderationRepo.listActiveBlocks).toHaveBeenCalledWith(ROOM.id, 0, 20, 'u9');
      expect(result).toEqual({
        items: [{ id: 'b1' }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('warnings returns the canonical Paginated<T> envelope, filtered by userId', async () => {
      const result = await subject.warnings(ELEVATED, ROOM.id, query({ userId: 'u9', page: 2 }));
      expect(warningRepo.list).toHaveBeenCalledWith(ROOM.id, { skip: 0, take: 20, userId: 'u9' });
      expect(result).toEqual({
        items: [{ id: 'w1' }],
        total: 1,
        page: 2,
        limit: 20,
        totalPages: 1,
      });
    });

    it('pagination math reflects the requested page/limit against total', async () => {
      moderationRepo.listActions.mockResolvedValueOnce([[{ id: 'a1' }], 45]);
      const result = await subject.history(ELEVATED, ROOM.id, query({ page: 2, limit: 20 }));
      expect(result.page).toBe(2);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(45);
      expect(result.totalPages).toBe(3);
    });
  });

  it('platform ADMIN bypasses the elevated-read gate via hasAnyPermission', async () => {
    const admin: RoomActor = { id: 'admin-x', roles: [PlatformRole.ADMIN] };
    permissions.hasAnyPermission.mockResolvedValueOnce(true);
    await expect(subject.history(admin, ROOM.id, query())).resolves.toBeDefined();
  });
});
