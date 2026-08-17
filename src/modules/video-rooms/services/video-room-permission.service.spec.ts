import { PlatformRole, VideoRoomMemberRole, VideoRoomSeatType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomPermission, videoRoomRolePermissions } from '../constants/video-room-permissions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPermissionService } from './video-room-permission.service';

const OWNER = 'owner-1';
const room = { id: 'r1', ownerId: OWNER };

function actor(id: string, roles: PlatformRole[] = []): RoomActor {
  return { id, roles };
}

describe('VideoRoomPermissionService', () => {
  let roles: { find: jest.Mock; findActive: jest.Mock };
  let seats: { findOccupiedSeat: jest.Mock };
  let cache: { read: jest.Mock; write: jest.Mock; invalidateRoom: jest.Mock };
  let metrics: {
    observeAuthorization: jest.Mock;
    incPermissionCheck: jest.Mock;
    incPermissionDenial: jest.Mock;
  };
  let service: VideoRoomPermissionService;

  beforeEach(() => {
    roles = { find: jest.fn(), findActive: jest.fn().mockResolvedValue(null) };
    seats = { findOccupiedSeat: jest.fn().mockResolvedValue(null) };
    // Default to a cold cache so each case exercises real resolution.
    cache = {
      read: jest.fn().mockResolvedValue(null),
      write: jest.fn(),
      invalidateRoom: jest.fn(),
    };
    metrics = {
      observeAuthorization: jest.fn(),
      incPermissionCheck: jest.fn(),
      incPermissionDenial: jest.fn(),
    };
    service = new VideoRoomPermissionService(
      roles as never,
      seats as never,
      cache as never,
      metrics as never,
    );
  });

  describe('resolveEffectiveRole', () => {
    it('resolves the room owner as OWNER without a grant lookup', async () => {
      expect(await service.resolveEffectiveRole(room, OWNER)).toBe(VideoRoomMemberRole.OWNER);
      expect(roles.findActive).not.toHaveBeenCalled();
    });

    it('resolves a granted role for a non-owner', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
      expect(await service.resolveEffectiveRole(room, 'u2')).toBe(VideoRoomMemberRole.MODERATOR);
    });

    it('resolves VIEWER for a stranger with no grant', async () => {
      expect(await service.resolveEffectiveRole(room, 'stranger')).toBe(VideoRoomMemberRole.VIEWER);
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
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      seats.findOccupiedSeat.mockResolvedValue({ seatType: VideoRoomSeatType.HOST });
      expect(await service.resolveEffectiveRole(room, 'u1')).toBe(VideoRoomMemberRole.ADMIN);
      expect(seats.findOccupiedSeat).not.toHaveBeenCalled();
    });

    // VR-7: the expiry-aware read is the whole point. Using the raw `find` here
    // would resurrect the bug where a lapsed temporary ADMIN kept its powers.
    it('uses the expiry-aware read, never the raw find', async () => {
      await service.resolveEffectiveRole(room, 'ghost');
      expect(roles.findActive).toHaveBeenCalledWith('r1', 'ghost');
      expect(roles.find).not.toHaveBeenCalled();
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
      expect(roles.findActive).not.toHaveBeenCalled();
    });

    it('lets the owner close the room', async () => {
      expect(await service.hasPermission(actor(OWNER), room, VideoRoomPermission.CLOSE_ROOM)).toBe(
        true,
      );
    });

    it('denies CLOSE_ROOM to an in-room ADMIN (owner-only power)', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      expect(await service.hasPermission(actor('u2'), room, VideoRoomPermission.CLOSE_ROOM)).toBe(
        false,
      );
    });

    // VR-7 behaviour change: the PRD bars admins from changing the room password,
    // so LOCK_ROOM became owner-only. This case asserted the opposite before.
    it('denies LOCK_ROOM to an in-room ADMIN (PRD admin restriction)', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      expect(await service.hasPermission(actor('u2'), room, VideoRoomPermission.LOCK_ROOM)).toBe(
        false,
      );
    });

    it('lets an in-room ADMIN manage seats (a PRD admin duty)', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      expect(await service.hasPermission(actor('u2'), room, VideoRoomPermission.MANAGE_SEATS)).toBe(
        true,
      );
    });

    it('denies LOCK_ROOM to a MODERATOR but allows KICK_USERS', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
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

    it('lets a bare platform Moderator (no in-room role) review reports', async () => {
      const ok = await service.hasPermission(
        actor('mod-1', [PlatformRole.MODERATOR]),
        room,
        VideoRoomPermission.REVIEW_REPORTS,
      );
      expect(ok).toBe(true);
      // The bypass short-circuits before any in-room role lookup.
      expect(roles.findActive).not.toHaveBeenCalled();
    });

    it('does not let a bare platform Moderator manage seats or settings (bypass is narrow)', async () => {
      expect(
        await service.hasPermission(
          actor('mod-1', [PlatformRole.MODERATOR]),
          room,
          VideoRoomPermission.MANAGE_SEATS,
        ),
      ).toBe(false);
      expect(
        await service.hasPermission(
          actor('mod-1', [PlatformRole.MODERATOR]),
          room,
          VideoRoomPermission.MANAGE_PARTICIPANTS,
        ),
      ).toBe(false);
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

  describe('VR-7 cache integration', () => {
    it('serves a cache hit without touching the repositories', async () => {
      cache.read.mockResolvedValue({
        ver: 3,
        role: VideoRoomMemberRole.ADMIN,
        permissions: [VideoRoomPermission.KICK_USERS],
        temporary: false,
      });
      await expect(
        service.hasPermission(actor('u2'), room, VideoRoomPermission.KICK_USERS),
      ).resolves.toBe(true);
      expect(roles.findActive).not.toHaveBeenCalled();
      expect(seats.findOccupiedSeat).not.toHaveBeenCalled();
    });

    it('resolves and memoises on a miss', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
      await service.hasPermission(actor('u2'), room, VideoRoomPermission.KICK_USERS);
      expect(cache.write).toHaveBeenCalledWith('r1', 'u2', {
        role: VideoRoomMemberRole.MODERATOR,
        permissions: videoRoomRolePermissions(VideoRoomMemberRole.MODERATOR),
        temporary: false,
      });
    });

    it('caches the owner decision too (owners are the hottest path)', async () => {
      await service.hasPermission(actor(OWNER), room, VideoRoomPermission.CLOSE_ROOM);
      expect(cache.write).toHaveBeenCalledWith(
        'r1',
        OWNER,
        expect.objectContaining({ role: VideoRoomMemberRole.OWNER }),
      );
    });
  });

  describe('VR-7 predicates', () => {
    it('hasRole compares the effective role', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      await expect(service.hasRole(actor('u2'), room, VideoRoomMemberRole.ADMIN)).resolves.toBe(
        true,
      );
      await expect(service.hasRole(actor('u2'), room, VideoRoomMemberRole.OWNER)).resolves.toBe(
        false,
      );
    });

    it('hasAnyPermission is true when one matches', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
      await expect(
        service.hasAnyPermission(actor('u2'), room, [
          VideoRoomPermission.MANAGE_SEATS,
          VideoRoomPermission.KICK_USERS,
        ]),
      ).resolves.toBe(true);
    });

    it('hasAllPermissions requires every one', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
      await expect(
        service.hasAllPermissions(actor('u2'), room, [
          VideoRoomPermission.MANAGE_SEATS,
          VideoRoomPermission.KICK_USERS,
        ]),
      ).resolves.toBe(false);
      await expect(
        service.hasAllPermissions(actor('u2'), room, [
          VideoRoomPermission.KICK_USERS,
          VideoRoomPermission.ROOM_MUTE,
        ]),
      ).resolves.toBe(true);
    });

    it('hasTemporaryRole is true only when the grant carries an expiry', async () => {
      roles.findActive.mockResolvedValue({
        role: VideoRoomMemberRole.ADMIN,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      await expect(service.hasTemporaryRole(room, 'u2')).resolves.toBe(true);
    });

    it('hasTemporaryRole is false for a permanent grant', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.ADMIN, expiresAt: null });
      await expect(service.hasTemporaryRole(room, 'u2')).resolves.toBe(false);
    });

    it('resolveCapabilities reports a platform admin as bypassing with every permission', async () => {
      const caps = await service.resolveCapabilities(actor('staff', [PlatformRole.ADMIN]), room);
      expect(caps.isPlatformAdmin).toBe(true);
      expect(caps.permissions).toEqual(expect.arrayContaining([VideoRoomPermission.MANAGE_ROOM]));
    });

    it('resolveCapabilities reports an ordinary member capability set', async () => {
      roles.findActive.mockResolvedValue({ role: VideoRoomMemberRole.MODERATOR, expiresAt: null });
      await expect(service.resolveCapabilities(actor('u2'), room)).resolves.toEqual({
        role: VideoRoomMemberRole.MODERATOR,
        permissions: videoRoomRolePermissions(VideoRoomMemberRole.MODERATOR),
        temporary: false,
        isPlatformAdmin: false,
      });
    });
  });

  describe('VR-7 instrumentation', () => {
    it('records latency and an allowed outcome for a granted check', async () => {
      await service.hasPermission(actor(OWNER), room, VideoRoomPermission.CLOSE_ROOM);
      expect(metrics.observeAuthorization).toHaveBeenCalledWith(expect.any(Number));
      expect(metrics.incPermissionCheck).toHaveBeenCalledWith('allowed');
      expect(metrics.incPermissionDenial).not.toHaveBeenCalled();
    });

    it('records the specific permission that was denied', async () => {
      await service.hasPermission(actor('stranger'), room, VideoRoomPermission.CLOSE_ROOM);
      expect(metrics.incPermissionCheck).toHaveBeenCalledWith('denied');
      expect(metrics.incPermissionDenial).toHaveBeenCalledWith(VideoRoomPermission.CLOSE_ROOM);
    });
  });

  // The coarse gate is gone: room management is MANAGE_ROOM, which is what makes
  // the PRD's "Admins CANNOT edit room profile" restriction expressible at all.
  it('no longer exposes assertCanManage', () => {
    expect((service as unknown as Record<string, unknown>).assertCanManage).toBeUndefined();
  });
});
