import { PlatformRole, VideoRoomMemberRole, VideoRoomSeatType } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPermissionService } from './video-room-permission.service';

const OWNER = 'owner-1';
const room = { id: 'r1', ownerId: OWNER };

function actor(id: string, roles: PlatformRole[] = []): RoomActor {
  return { id, roles };
}

describe('VideoRoomPermissionService', () => {
  let roles: { find: jest.Mock };
  let seats: { findOccupiedSeat: jest.Mock };
  let service: VideoRoomPermissionService;

  beforeEach(() => {
    roles = { find: jest.fn().mockResolvedValue(null) };
    seats = { findOccupiedSeat: jest.fn().mockResolvedValue(null) };
    service = new VideoRoomPermissionService(roles as any, seats as any);
  });

  describe('resolveEffectiveRole', () => {
    it('resolves the room owner as OWNER without a grant lookup', async () => {
      expect(await service.resolveEffectiveRole(room, OWNER)).toBe(VideoRoomMemberRole.OWNER);
      expect(roles.find).not.toHaveBeenCalled();
    });

    it('resolves a granted role for a non-owner', async () => {
      roles.find.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR });
      expect(await service.resolveEffectiveRole(room, 'u2')).toBe(VideoRoomMemberRole.MODERATOR);
    });

    it('resolves null for a stranger with no grant', async () => {
      expect(await service.resolveEffectiveRole(room, 'stranger')).toBeNull();
    });

    it('resolves HOST when the user occupies a HOST seat (no grant)', async () => {
      seats.findOccupiedSeat.mockResolvedValue({ seatType: VideoRoomSeatType.HOST });
      expect(await service.resolveEffectiveRole(room, 'u1')).toBe(VideoRoomMemberRole.HOST);
    });

    it('resolves PARTICIPANT when the user occupies a GUEST seat (no grant)', async () => {
      seats.findOccupiedSeat.mockResolvedValue({ seatType: VideoRoomSeatType.GUEST });
      expect(await service.resolveEffectiveRole(room, 'u1')).toBe(VideoRoomMemberRole.PARTICIPANT);
    });

    it('prefers a grant over seat occupancy', async () => {
      roles.find.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN });
      seats.findOccupiedSeat.mockResolvedValue({ seatType: VideoRoomSeatType.HOST });
      expect(await service.resolveEffectiveRole(room, 'u1')).toBe(VideoRoomMemberRole.ADMIN);
      expect(seats.findOccupiedSeat).not.toHaveBeenCalled();
    });
  });

  describe('authorityRank / assertOutranks', () => {
    it('ranks OWNER above a seated HOST', async () => {
      expect(await service.authorityRank(room, OWNER)).toBe(5);
      seats.findOccupiedSeat.mockResolvedValue({ seatType: VideoRoomSeatType.HOST });
      expect(await service.authorityRank(room, 'u1')).toBe(2);
    });

    it('assertOutranks throws when the actor does not outrank the target', async () => {
      jest.spyOn(service, 'authorityRank').mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      await expect(service.assertOutranks(room, 'actor', 'target')).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
    });

    it('assertOutranks resolves when the actor outranks the target', async () => {
      jest.spyOn(service, 'authorityRank').mockResolvedValueOnce(4).mockResolvedValueOnce(2);
      await expect(service.assertOutranks(room, 'actor', 'target')).resolves.toBeUndefined();
    });
  });

  describe('hasPermission', () => {
    it('grants everything to a platform admin (bypass)', async () => {
      const ok = await service.hasPermission(
        actor('stranger', [PlatformRole.ADMIN]),
        room,
        VideoRoomPermission.CLOSE_ROOM,
      );
      expect(ok).toBe(true);
      expect(roles.find).not.toHaveBeenCalled();
    });

    it('lets the owner close the room', async () => {
      expect(await service.hasPermission(actor(OWNER), room, VideoRoomPermission.CLOSE_ROOM)).toBe(
        true,
      );
    });

    it('denies CLOSE_ROOM to an in-room ADMIN (owner-only power)', async () => {
      roles.find.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN });
      expect(await service.hasPermission(actor('u2'), room, VideoRoomPermission.CLOSE_ROOM)).toBe(
        false,
      );
    });

    it('lets an in-room ADMIN lock the room', async () => {
      roles.find.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN });
      expect(await service.hasPermission(actor('u2'), room, VideoRoomPermission.LOCK_ROOM)).toBe(
        true,
      );
    });

    it('denies LOCK_ROOM to a MODERATOR but allows KICK_USERS', async () => {
      roles.find.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR });
      expect(await service.hasPermission(actor('u2'), room, VideoRoomPermission.LOCK_ROOM)).toBe(
        false,
      );
      expect(await service.hasPermission(actor('u2'), room, VideoRoomPermission.KICK_USERS)).toBe(
        true,
      );
    });

    it('denies everything to a stranger', async () => {
      expect(await service.hasPermission(actor('x'), room, VideoRoomPermission.LOCK_ROOM)).toBe(
        false,
      );
    });
  });

  describe('assertPermission', () => {
    it('throws VIDEO_ROOM_FORBIDDEN (403) when the actor lacks the permission', async () => {
      await expect(
        service.assertPermission(actor('x'), room, VideoRoomPermission.CLOSE_ROOM),
      ).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
        status: 403,
      });
    });

    it('resolves silently when the actor has the permission', async () => {
      await expect(
        service.assertPermission(actor(OWNER), room, VideoRoomPermission.CLOSE_ROOM),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertCanManage', () => {
    it('allows the owner', async () => {
      await expect(service.assertCanManage(actor(OWNER), room)).resolves.toBeUndefined();
    });

    it('allows a platform admin', async () => {
      await expect(
        service.assertCanManage(actor('x', [PlatformRole.SUPER_ADMIN]), room),
      ).resolves.toBeUndefined();
    });

    it('allows an in-room ADMIN', async () => {
      roles.find.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN });
      await expect(service.assertCanManage(actor('u2'), room)).resolves.toBeUndefined();
    });

    it('rejects a MODERATOR (cannot reshape the room)', async () => {
      roles.find.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR });
      await expect(service.assertCanManage(actor('u2'), room)).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('rejects a stranger', async () => {
      await expect(service.assertCanManage(actor('x'), room)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_FORBIDDEN,
      });
    });
  });
});
