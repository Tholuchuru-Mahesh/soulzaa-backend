import { PlatformRole, VideoRoomMemberRole } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { VideoRoomRolesController } from './video-rooms-roles.controller';

const user = { id: 'u1', roles: [PlatformRole.USER], sid: 's1' } as unknown as AuthenticatedUser;

describe('VideoRoomRolesController', () => {
  let rolesService: any;
  let ownership: any;
  let permissions: any;
  let rooms: any;
  let subject: VideoRoomRolesController;

  beforeEach(() => {
    rolesService = {
      listRoles: jest.fn().mockResolvedValue([]),
      assign: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    ownership = {
      transfer: jest.fn().mockResolvedValue(undefined),
      recoverOwner: jest.fn().mockResolvedValue({ newOwnerId: 'u2' }),
    };
    permissions = {
      resolveCapabilities: jest.fn().mockResolvedValue({
        role: null,
        permissions: [],
        temporary: false,
        isPlatformAdmin: false,
      }),
    };
    rooms = { findById: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'o1' }) };
    subject = new VideoRoomRolesController(rolesService, ownership, permissions, rooms);
  });

  const expectedActor = { id: 'u1', roles: [PlatformRole.USER] };

  describe('delegation — the controller decides nothing itself', () => {
    it('delegates listing', async () => {
      await subject.list(user, 'r1');
      expect(rolesService.listRoles).toHaveBeenCalledWith(expectedActor, 'r1');
    });

    it('delegates assign', async () => {
      const dto = { userId: 'u2', role: VideoRoomMemberRole.ADMIN } as never;
      await subject.assign(user, 'r1', dto);
      expect(rolesService.assign).toHaveBeenCalledWith(expectedActor, 'r1', dto);
    });

    it('delegates remove', async () => {
      await subject.remove(user, 'r1', { userId: 'u2' });
      expect(rolesService.remove).toHaveBeenCalledWith(expectedActor, 'r1', { userId: 'u2' });
    });

    it('delegates update', async () => {
      const dto = { userId: 'u2', role: VideoRoomMemberRole.MODERATOR } as never;
      await subject.update(user, 'r1', dto);
      expect(rolesService.update).toHaveBeenCalledWith(expectedActor, 'r1', dto);
    });

    it('delegates ownership transfer', async () => {
      await subject.transfer(user, 'r1', { newOwnerId: 'u2' });
      expect(ownership.transfer).toHaveBeenCalledWith(expectedActor, 'r1', { newOwnerId: 'u2' });
    });

    it('delegates owner recovery, passing the full actor so the room can be closed', async () => {
      await expect(subject.recover(user, 'r1')).resolves.toEqual({ newOwnerId: 'u2' });
      expect(ownership.recoverOwner).toHaveBeenCalledWith(expectedActor, 'r1');
    });
  });

  describe('catalogue', () => {
    it('returns every permission and a matrix entry per role', () => {
      const result = subject.catalogue();
      expect(result.permissions).toContain(VideoRoomPermission.MANAGE_ROOM);
      expect(Object.keys(result.matrix)).toEqual(
        expect.arrayContaining(Object.values(VideoRoomMemberRole)),
      );
    });

    it('reflects the PRD-tightened admin matrix', () => {
      const { matrix } = subject.catalogue();
      expect(matrix.VIEWER).toEqual([]);
      expect(matrix.ADMIN).not.toContain(VideoRoomPermission.GRANT_ROLES);
      expect(matrix.ADMIN).not.toContain(VideoRoomPermission.MANAGE_ROOM);
      expect(matrix.ADMIN).toContain(VideoRoomPermission.MANAGE_SEATS);
      expect(matrix.OWNER).toContain(VideoRoomPermission.MANAGE_ROOM);
    });
  });

  describe('me/permissions', () => {
    it('resolves the caller capabilities against the room', async () => {
      await subject.myPermissions(user, 'r1');
      expect(permissions.resolveCapabilities).toHaveBeenCalledWith(expectedActor, {
        id: 'r1',
        ownerId: 'o1',
      });
    });

    it('404s for an unknown room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(subject.myPermissions(user, 'r1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });
  });
});
