import { HttpStatus } from '@nestjs/common';
import { PlatformRole, VideoRoomMemberRole } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomRoleService } from './video-room-role.service';

const ROOM = { id: 'r1', ownerId: 'owner-1' };
const owner: RoomActor = { id: 'owner-1', roles: [] as PlatformRole[] };
const TARGET = 'user-2';

describe('VideoRoomRoleService', () => {
  let rooms: any;
  let roles: any;
  let moderation: any;
  let permissions: any;
  let cache: any;
  let bus: any;
  let subject: VideoRoomRoleService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getMember: jest.fn().mockResolvedValue({ userId: TARGET, isActive: true }),
      setMemberRole: jest.fn(),
      appendLog: jest.fn(),
    };
    roles = {
      findActive: jest.fn().mockResolvedValue(null),
      listActiveByRoom: jest.fn().mockResolvedValue([]),
      countByRole: jest.fn().mockResolvedValue(0),
      grant: jest
        .fn()
        .mockImplementation(({ userId, role, grantedBy, expiresAt }) =>
          Promise.resolve({ userId, role, grantedBy, expiresAt: expiresAt ?? null }),
        ),
      revoke: jest.fn().mockResolvedValue(1),
    };
    moderation = { appendAction: jest.fn() };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
      resolveEffectiveRole: jest.fn().mockResolvedValue(null),
      // Default scenario: the room owner (rank 5) acting on a plain member
      // (rank 0). Cases that exercise the hierarchy override this.
      authorityRank: jest.fn((_room: unknown, userId: string) =>
        Promise.resolve(userId === owner.id ? 5 : 0),
      ),
    };
    cache = { invalidateRoom: jest.fn() };
    bus = { publish: jest.fn() };
    subject = new VideoRoomRoleService(rooms, roles, moderation, permissions, cache, bus);
  });

  const assign = (
    role: VideoRoomMemberRole = VideoRoomMemberRole.ADMIN,
    expiresAt?: string,
  ): Promise<unknown> => subject.assign(owner, 'r1', { userId: TARGET, role, expiresAt } as never);

  const publishedNames = (): string[] =>
    bus.publish.mock.calls.map(([event]: [{ name: string }]) => event.name);

  describe('assign — validation chain', () => {
    it('requires GRANT_ROLES before anything else', async () => {
      permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
      await expect(assign()).rejects.toThrow('forbidden');
      expect(roles.grant).not.toHaveBeenCalled();
    });

    it('rejects an unknown room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(assign()).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    it('rejects a target who is not an active member', async () => {
      rooms.getMember.mockResolvedValue({ userId: TARGET, isActive: false });
      await expect(assign()).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
      });
    });

    it('rejects a target with no member row at all', async () => {
      rooms.getMember.mockResolvedValue(null);
      await expect(assign()).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
      });
    });

    it('rejects a self-grant', async () => {
      await expect(
        subject.assign(owner, 'r1', {
          userId: owner.id,
          role: VideoRoomMemberRole.ADMIN,
        } as never),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY });
    });

    it('rejects OWNER as a grantable role — ownership is transferred', async () => {
      await expect(assign(VideoRoomMemberRole.OWNER)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_ROLE_INVALID,
      });
    });

    it('rejects granting the role the target already holds', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      await expect(assign()).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_DUPLICATE_ROLE,
        status: HttpStatus.CONFLICT,
      });
    });

    it('enforces the PRD 25-admin cap at the boundary', async () => {
      roles.countByRole.mockResolvedValue(24);
      await expect(assign()).resolves.toBeDefined();

      roles.countByRole.mockResolvedValue(25);
      await expect(assign()).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_ROLE_LIMIT_EXCEEDED,
        status: HttpStatus.CONFLICT,
      });
    });

    it('does not cap MODERATOR grants', async () => {
      roles.countByRole.mockResolvedValue(999);
      await expect(assign(VideoRoomMemberRole.MODERATOR)).resolves.toBeDefined();
    });
  });

  describe('assign — write path', () => {
    it('persists, mirrors the member role, audits both trails, invalidates and publishes', async () => {
      await assign();
      expect(roles.grant).toHaveBeenCalledWith({
        roomId: 'r1',
        userId: TARGET,
        role: VideoRoomMemberRole.ADMIN,
        grantedBy: owner.id,
        expiresAt: null,
      });
      expect(rooms.setMemberRole).toHaveBeenCalledWith(
        'r1',
        TARGET,
        VideoRoomMemberRole.ADMIN,
        owner.id,
      );
      expect(rooms.appendLog).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: 'r1', actorId: owner.id, action: 'ROLE_CHANGED' }),
      );
      expect(moderation.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ROLE_GRANTED', targetUserId: TARGET }),
      );
      expect(cache.invalidateRoom).toHaveBeenCalledWith('r1');
      expect(publishedNames()).toContain('video_room.role_assigned');
    });

    it('publishes the temporary event alongside the assignment when an expiry is set', async () => {
      await assign(VideoRoomMemberRole.ADMIN, '2099-01-01T00:00:00.000Z');
      expect(publishedNames()).toContain('video_room.role_assigned');
      expect(publishedNames()).toContain('video_room.temporary_role_granted');
    });

    it('does not publish the temporary event for a permanent grant', async () => {
      await assign();
      expect(publishedNames()).not.toContain('video_room.temporary_role_granted');
    });

    it('returns the grant marked temporary when it carries an expiry', async () => {
      const result = await assign(VideoRoomMemberRole.ADMIN, '2099-01-01T00:00:00.000Z');
      expect(result).toMatchObject({
        userId: TARGET,
        role: VideoRoomMemberRole.ADMIN,
        temporary: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });
  });

  describe('remove', () => {
    it('rejects when the target holds no grant', async () => {
      roles.findActive.mockResolvedValue(null);
      await expect(subject.remove(owner, 'r1', { userId: TARGET })).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND,
      });
    });

    it('refuses to revoke OWNER — transfer instead', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.OWNER, expiresAt: null });
      await expect(subject.remove(owner, 'r1', { userId: TARGET })).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_ROLE_INVALID,
      });
    });

    it('revokes, demotes the member mirror to VIEWER, audits, invalidates and publishes', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      await subject.remove(owner, 'r1', { userId: TARGET });
      expect(roles.revoke).toHaveBeenCalledWith('r1', TARGET);
      expect(rooms.setMemberRole).toHaveBeenCalledWith(
        'r1',
        TARGET,
        VideoRoomMemberRole.VIEWER,
        owner.id,
      );
      expect(moderation.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ROLE_REVOKED' }),
      );
      expect(cache.invalidateRoom).toHaveBeenCalledWith('r1');
      expect(publishedNames()).toContain('video_room.role_removed');
    });
  });

  describe('update', () => {
    it('rejects when the target holds no grant to change', async () => {
      roles.findActive.mockResolvedValue(null);
      await expect(
        subject.update(owner, 'r1', {
          userId: TARGET,
          role: VideoRoomMemberRole.MODERATOR,
        } as never),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_ROLE_NOT_FOUND });
    });

    it('replaces the role and publishes RoleUpdated carrying the previous role', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
      await subject.update(owner, 'r1', {
        userId: TARGET,
        role: VideoRoomMemberRole.ADMIN,
      } as never);
      const updated = bus.publish.mock.calls
        .map(([event]: [{ name: string; payload: Record<string, unknown> }]) => event)
        .find((event: { name: string }) => event.name === 'video_room.role_updated');
      expect(updated.payload).toMatchObject({
        previousRole: VideoRoomMemberRole.MODERATOR,
        role: VideoRoomMemberRole.ADMIN,
      });
    });

    it('re-checks the admin cap when promoting into ADMIN', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
      roles.countByRole.mockResolvedValue(25);
      await expect(
        subject.update(owner, 'r1', {
          userId: TARGET,
          role: VideoRoomMemberRole.ADMIN,
        } as never),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_ROLE_LIMIT_EXCEEDED });
    });

    it('skips the cap check when the role is unchanged (expiry-only edit)', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      roles.countByRole.mockResolvedValue(25);
      await expect(
        subject.update(owner, 'r1', {
          userId: TARGET,
          role: VideoRoomMemberRole.ADMIN,
          expiresAt: '2099-01-01T00:00:00.000Z',
        } as never),
      ).resolves.toBeDefined();
    });
  });

  describe('listRoles', () => {
    it('requires the caller to be an active member', async () => {
      rooms.getMember.mockResolvedValue(null);
      await expect(subject.listRoles(owner, 'r1')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
      });
    });

    it('marks grants carrying an expiry as temporary', async () => {
      roles.listActiveByRoom.mockResolvedValue([
        { userId: 'a', role: VideoRoomMemberRole.ADMIN, grantedBy: 'owner-1', expiresAt: null },
        {
          userId: 'b',
          role: VideoRoomMemberRole.MODERATOR,
          grantedBy: 'owner-1',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      ]);
      const result = await subject.listRoles(owner, 'r1');
      expect(result[0]).toMatchObject({ temporary: false, expiresAt: null });
      expect(result[1]).toMatchObject({
        temporary: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });
  });

  // Policy: strict hierarchy · platform staff bypass · owner never a target.
  describe('anti-escalation policy', () => {
    describe('strict outranking', () => {
      it('rejects equal rank — peers cannot modify each other', async () => {
        permissions.authorityRank.mockResolvedValue(5);
        await expect(assign()).rejects.toMatchObject({
          errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY,
          status: HttpStatus.FORBIDDEN,
        });
      });

      it('rejects an admin acting on a peer admin (griefing vector)', async () => {
        const admin: RoomActor = { id: 'admin-1', roles: [] };
        permissions.authorityRank.mockResolvedValue(4);
        await expect(
          subject.assign(admin, 'r1', {
            userId: TARGET,
            role: VideoRoomMemberRole.MODERATOR,
          } as never),
        ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY });
      });

      it('rejects a lower-ranked actor acting upward', async () => {
        const mod: RoomActor = { id: 'mod-1', roles: [] };
        permissions.authorityRank.mockImplementation((_room: unknown, userId: string) =>
          Promise.resolve(userId === 'mod-1' ? 3 : 4),
        );
        await expect(
          subject.assign(mod, 'r1', {
            userId: TARGET,
            role: VideoRoomMemberRole.MODERATOR,
          } as never),
        ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_INVALID_HIERARCHY });
      });

      it('allows a strictly higher-ranked actor', async () => {
        permissions.authorityRank.mockImplementation((_room: unknown, userId: string) =>
          Promise.resolve(userId === owner.id ? 5 : 3),
        );
        await expect(assign()).resolves.toBeDefined();
      });
    });

    describe('owner immunity', () => {
      it('refuses to target the room owner, by ownerId not by rank', async () => {
        const admin: RoomActor = { id: 'admin-1', roles: [] };
        rooms.getMember.mockResolvedValue({ userId: ROOM.ownerId, isActive: true });
        permissions.authorityRank.mockResolvedValue(4);
        await expect(
          subject.assign(admin, 'r1', {
            userId: ROOM.ownerId,
            role: VideoRoomMemberRole.MODERATOR,
          } as never),
        ).rejects.toMatchObject({
          errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER,
          status: HttpStatus.FORBIDDEN,
        });
      });

      it('refuses to revoke a grant from the room owner', async () => {
        const admin: RoomActor = { id: 'admin-1', roles: [] };
        roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
        await expect(subject.remove(admin, 'r1', { userId: ROOM.ownerId })).rejects.toMatchObject({
          errorCode: ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_OWNER,
        });
      });
    });

    describe('platform staff bypass', () => {
      // Staff hold no in-room role (rank 0), so without the bypass they could not
      // act on anyone — which is exactly the support/recovery case.
      it('lets a platform ADMIN act despite holding no in-room rank', async () => {
        const staff: RoomActor = { id: 'staff-1', roles: [PlatformRole.ADMIN] };
        permissions.authorityRank.mockResolvedValue(0);
        await expect(
          subject.assign(staff, 'r1', {
            userId: TARGET,
            role: VideoRoomMemberRole.ADMIN,
          } as never),
        ).resolves.toBeDefined();
      });

      it('lets a SUPER_ADMIN act on the room owner (emergency recovery)', async () => {
        const staff: RoomActor = { id: 'staff-1', roles: [PlatformRole.SUPER_ADMIN] };
        rooms.getMember.mockResolvedValue({ userId: ROOM.ownerId, isActive: true });
        permissions.authorityRank.mockResolvedValue(0);
        await expect(
          subject.assign(staff, 'r1', {
            userId: ROOM.ownerId,
            role: VideoRoomMemberRole.ADMIN,
          } as never),
        ).resolves.toBeDefined();
      });

      it('does not consult in-room rank at all for staff', async () => {
        const staff: RoomActor = { id: 'staff-1', roles: [PlatformRole.ADMIN] };
        await subject.assign(staff, 'r1', {
          userId: TARGET,
          role: VideoRoomMemberRole.MODERATOR,
        } as never);
        expect(permissions.authorityRank).not.toHaveBeenCalled();
      });
    });
  });
});
