import { HttpStatus } from '@nestjs/common';
import { PlatformRole, VideoRoomMemberRole } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomOwnershipService } from './video-room-ownership.service';

const ROOM = { id: 'r1', ownerId: 'owner-1' };
const owner: RoomActor = { id: 'owner-1', roles: [] as PlatformRole[] };
const staff: RoomActor = { id: 'staff-1', roles: [PlatformRole.ADMIN] };

describe('VideoRoomOwnershipService', () => {
  let rooms: any;
  let roles: any;
  let permissions: any;
  let cache: any;
  let locks: any;
  let lifecycle: any;
  let bus: any;
  let subject: VideoRoomOwnershipService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getMember: jest.fn().mockResolvedValue({ userId: 'user-2', isActive: true }),
      setOwner: jest.fn(),
      setMemberRole: jest.fn(),
      appendLog: jest.fn(),
      listActiveMembers: jest.fn().mockResolvedValue([]),
    };
    roles = { grant: jest.fn(), revoke: jest.fn() };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
      authorityRank: jest.fn().mockResolvedValue(0),
    };
    cache = { invalidateRoom: jest.fn() };
    locks = { withLock: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()) };
    lifecycle = { close: jest.fn() };
    bus = { publish: jest.fn() };
    subject = new VideoRoomOwnershipService(
      rooms,
      roles,
      permissions,
      cache,
      locks,
      lifecycle,
      bus,
    );
  });

  const firstEvent = () => bus.publish.mock.calls[0][0];

  describe('transfer', () => {
    it('requires TRANSFER_OWNERSHIP', async () => {
      permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
      await expect(subject.transfer(owner, 'r1', { newOwnerId: 'user-2' })).rejects.toThrow(
        'forbidden',
      );
      expect(rooms.setOwner).not.toHaveBeenCalled();
    });

    it('rejects an unknown room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(subject.transfer(owner, 'r1', { newOwnerId: 'user-2' })).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    // Two concurrent transfers must not interleave and leave the room with the
    // previous owner demoted but handed to neither target.
    it('serialises the swap under a per-room lock', async () => {
      await subject.transfer(owner, 'r1', { newOwnerId: 'user-2' });
      expect(locks.withLock).toHaveBeenCalledWith('video-room:transfer:{r1}', expect.any(Function));
    });

    it('rejects transferring to the current owner', async () => {
      await expect(subject.transfer(owner, 'r1', { newOwnerId: 'owner-1' })).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_OWNERSHIP_TRANSFER_FAILED,
        status: HttpStatus.CONFLICT,
      });
    });

    it('rejects a target who is not an active member', async () => {
      rooms.getMember.mockResolvedValue({ userId: 'user-2', isActive: false });
      await expect(subject.transfer(owner, 'r1', { newOwnerId: 'user-2' })).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
      });
    });

    it('demotes the previous owner to ADMIN and promotes the target', async () => {
      await subject.transfer(owner, 'r1', { newOwnerId: 'user-2' });
      expect(roles.grant).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: 'r1',
          userId: 'owner-1',
          role: VideoRoomMemberRole.ADMIN,
        }),
      );
      expect(rooms.setOwner).toHaveBeenCalledWith('r1', 'user-2', 'owner-1');
      expect(rooms.setMemberRole).toHaveBeenCalledWith(
        'r1',
        'user-2',
        VideoRoomMemberRole.OWNER,
        'owner-1',
      );
    });

    // Ownership is expressed by room.ownerId. Leaving the new owner's old grant
    // in place would give them two sources of authority and make a later
    // revocation ambiguous.
    it('clears the new owner previous elevated grant', async () => {
      await subject.transfer(owner, 'r1', { newOwnerId: 'user-2' });
      expect(roles.revoke).toHaveBeenCalledWith('r1', 'user-2');
    });

    it('logs, invalidates the cache and publishes with reason TRANSFER', async () => {
      await subject.transfer(owner, 'r1', { newOwnerId: 'user-2' });
      expect(rooms.appendLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'OWNERSHIP_TRANSFERRED',
          metadata: expect.objectContaining({
            previousOwnerId: 'owner-1',
            newOwnerId: 'user-2',
          }),
        }),
      );
      expect(cache.invalidateRoom).toHaveBeenCalledWith('r1');
      expect(firstEvent().payload).toMatchObject({
        reason: 'TRANSFER',
        newOwnerId: 'user-2',
        previousOwnerId: 'owner-1',
      });
    });
  });

  describe('recoverOwner', () => {
    it('promotes the highest-ranking active member that is not the departed owner', async () => {
      rooms.listActiveMembers.mockResolvedValue([
        { userId: 'owner-1' },
        { userId: 'mod-1' },
        { userId: 'admin-1' },
      ]);
      permissions.authorityRank.mockImplementation((_room: unknown, userId: string) =>
        Promise.resolve(userId === 'admin-1' ? 4 : userId === 'mod-1' ? 3 : 5),
      );
      await expect(subject.recoverOwner(staff, 'r1')).resolves.toEqual({
        newOwnerId: 'admin-1',
      });
      expect(rooms.setOwner).toHaveBeenCalledWith('r1', 'admin-1', 'staff-1');
    });

    // Succession is not a handover — the departed owner gets no consolation
    // ADMIN grant, unlike a deliberate transfer.
    it('does not grant the departed owner an ADMIN role', async () => {
      rooms.listActiveMembers.mockResolvedValue([{ userId: 'owner-1' }, { userId: 'admin-1' }]);
      permissions.authorityRank.mockResolvedValue(1);
      await subject.recoverOwner(staff, 'r1');
      expect(roles.grant).not.toHaveBeenCalled();
    });

    it('publishes with reason RECOVERY', async () => {
      rooms.listActiveMembers.mockResolvedValue([{ userId: 'owner-1' }, { userId: 'admin-1' }]);
      permissions.authorityRank.mockResolvedValue(1);
      await subject.recoverOwner(staff, 'r1');
      expect(firstEvent().payload).toMatchObject({ reason: 'RECOVERY' });
    });

    it('closes the room when there is no successor', async () => {
      rooms.listActiveMembers.mockResolvedValue([{ userId: 'owner-1' }]);
      await expect(subject.recoverOwner(staff, 'r1')).resolves.toEqual({ newOwnerId: null });
      expect(lifecycle.close).toHaveBeenCalledWith(staff, 'r1');
      expect(rooms.setOwner).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('serialises recovery under the same per-room lock as transfer', async () => {
      await subject.recoverOwner(staff, 'r1');
      expect(locks.withLock).toHaveBeenCalledWith('video-room:transfer:{r1}', expect.any(Function));
    });
  });
});
