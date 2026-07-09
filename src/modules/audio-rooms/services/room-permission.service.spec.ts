import { RoomMemberRole } from '@prisma/client';
import { RoomPermission } from '../constants/room-permissions';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { RoomPermissionService } from './room-permission.service';

describe('RoomPermissionService', () => {
  let rooms: Record<string, jest.Mock>;
  let seats: Record<string, jest.Mock>;
  let service: RoomPermissionService;

  beforeEach(() => {
    rooms = { getMember: jest.fn().mockResolvedValue({ isActive: true }) };
    seats = {
      getRole: jest.fn().mockResolvedValue(null),
      getSeatByOccupant: jest.fn().mockResolvedValue(null),
    };
    service = new RoomPermissionService(
      rooms as unknown as AudioRoomsRepository,
      seats as unknown as AudioRoomSeatsRepository,
    );
  });

  describe('getEffectiveRole', () => {
    it('returns null for a non-member', async () => {
      rooms.getMember.mockResolvedValue(null);
      expect(await service.getEffectiveRole('r', 'u')).toBeNull();
    });

    it('returns the room_roles grant when present', async () => {
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.ADMIN });
      expect(await service.getEffectiveRole('r', 'u')).toBe(RoomMemberRole.ADMIN);
    });

    it('returns SPEAKER when the user occupies a seat (no grant)', async () => {
      seats.getSeatByOccupant.mockResolvedValue({ seatIndex: 3 });
      expect(await service.getEffectiveRole('r', 'u')).toBe(RoomMemberRole.SPEAKER);
    });

    it('returns LISTENER for an active member with no grant/seat', async () => {
      expect(await service.getEffectiveRole('r', 'u')).toBe(RoomMemberRole.LISTENER);
    });
  });

  describe('permission matrix', () => {
    it('grants an ADMIN manage-seats but not delete-room', async () => {
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.ADMIN });
      expect(await service.userHasPermission('r', 'u', RoomPermission.MANAGE_SEATS)).toBe(true);
      expect(await service.userHasPermission('r', 'u', RoomPermission.DELETE_ROOM)).toBe(false);
      expect(await service.userHasPermission('r', 'u', RoomPermission.TRANSFER_OWNERSHIP)).toBe(
        false,
      );
    });

    it('gives PREMIUM_ADMIN the same permissions as ADMIN (minus transfer/delete)', async () => {
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.PREMIUM_ADMIN });
      expect(await service.userHasPermission('r', 'u', RoomPermission.MANAGE_SPEAKERS)).toBe(true);
      expect(await service.userHasPermission('r', 'u', RoomPermission.DELETE_ROOM)).toBe(false);
    });

    it('gives OWNER every permission', async () => {
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.OWNER });
      expect(await service.userHasPermission('r', 'u', RoomPermission.DELETE_ROOM)).toBe(true);
      expect(await service.userHasPermission('r', 'u', RoomPermission.TRANSFER_OWNERSHIP)).toBe(
        true,
      );
    });

    it('denies a LISTENER all moderation permissions', async () => {
      expect(await service.userHasPermission('r', 'u', RoomPermission.MANAGE_SEATS)).toBe(false);
      expect(await service.userHasPermission('r', 'u', RoomPermission.MUTE_USERS)).toBe(false);
    });
  });

  describe('assertPermission / platform bypass', () => {
    it('lets a platform ADMIN bypass in-room checks', async () => {
      rooms.getMember.mockResolvedValue(null); // not even a member
      await expect(
        service.assertPermission('r', { id: 'a', roles: ['ADMIN'] }, RoomPermission.ROOM_MUTE),
      ).resolves.toBeUndefined();
    });

    it('throws for a listener lacking the permission', async () => {
      await expect(
        service.assertPermission('r', { id: 'u', roles: ['USER'] }, RoomPermission.MANAGE_SEATS),
      ).rejects.toBeDefined();
    });
  });

  describe('moderation authority (AR-3)', () => {
    it('recognises a platform MODERATOR as a moderator (not a full admin)', () => {
      expect(service.isPlatformModerator(['MODERATOR'])).toBe(true);
      expect(service.isPlatformModerator(['ADMIN'])).toBe(true);
      expect(service.isPlatformModerator(['USER'])).toBe(false);
      expect(service.isPlatformAdmin(['MODERATOR'])).toBe(false);
    });

    it('lets an in-room ADMIN moderate this room', async () => {
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.ADMIN });
      expect(await service.canModerate('r', { id: 'u', roles: ['USER'] })).toBe(true);
    });

    it('lets a platform moderator moderate any room', async () => {
      rooms.getMember.mockResolvedValue(null); // not even a member
      expect(await service.canModerate('r', { id: 'm', roles: ['MODERATOR'] })).toBe(true);
    });

    it('authorityRank ranks owner above admin above listener', async () => {
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.OWNER });
      expect(await service.authorityRank('r', 'owner')).toBe(4);
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.ADMIN });
      expect(await service.authorityRank('r', 'admin')).toBe(3);
      seats.getRole.mockResolvedValue(null);
      seats.getSeatByOccupant.mockResolvedValue(null);
      expect(await service.authorityRank('r', 'listener')).toBe(1);
    });

    it('an in-room admin cannot moderate the room owner', async () => {
      // target resolves to OWNER
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.OWNER });
      await expect(
        service.assertOutranks('r', { id: 'admin', roles: ['USER'] }, 'owner'),
      ).rejects.toBeDefined();
    });

    it('a platform admin outranks everyone (including the owner)', async () => {
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.OWNER });
      await expect(
        service.assertOutranks('r', { id: 'a', roles: ['ADMIN'] }, 'owner'),
      ).resolves.toBeUndefined();
    });

    it('a platform moderator cannot moderate the owner but can moderate a listener', async () => {
      seats.getRole.mockResolvedValue({ role: RoomMemberRole.OWNER });
      await expect(
        service.assertOutranks('r', { id: 'm', roles: ['MODERATOR'] }, 'owner'),
      ).rejects.toBeDefined();
      seats.getRole.mockResolvedValue(null);
      seats.getSeatByOccupant.mockResolvedValue(null);
      await expect(
        service.assertOutranks('r', { id: 'm', roles: ['MODERATOR'] }, 'listener'),
      ).resolves.toBeUndefined();
    });
  });
});
