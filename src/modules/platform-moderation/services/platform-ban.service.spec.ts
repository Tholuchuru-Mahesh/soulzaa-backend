// src/modules/platform-moderation/services/platform-ban.service.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { PlatformBanService } from './platform-ban.service';

describe('PlatformBanService', () => {
  let repo: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let redis: Record<string, jest.Mock>;
  let sockets: Record<string, jest.Mock>;
  let prisma: {
    audioRoom: Record<string, jest.Mock>;
    videoRoom: Record<string, jest.Mock>;
    liveStream: Record<string, jest.Mock>;
  };
  let bus: Record<string, jest.Mock>;
  let service: PlatformBanService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue({
        id: 'ban-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        expiresAt: new Date('2026-08-19T00:00:00.000Z'),
      }),
      findById: jest.fn().mockResolvedValue({
        id: 'ban-1',
        status: 'ACTIVE',
        targetUserId: 'target-1',
      }),
      lift: jest.fn().mockResolvedValue({ id: 'ban-1', status: 'LIFTED' }),
      list: jest.fn().mockResolvedValue([[], 0]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };
    sockets = {
      disconnectUserEverywhere: jest.fn(),
      emitToUserEverywhere: jest.fn(),
      emitToNamespaceRoom: jest.fn(),
    };
    prisma = {
      audioRoom: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      videoRoom: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      liveStream: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new PlatformBanService(
      repo as never,
      audit as never,
      redis as never,
      sockets as never,
      prisma as never,
      bus as never,
    );
  });

  describe('banUser', () => {
    it('rejects an empty reason', async () => {
      await expect(
        service.banUser({
          moderatorId: 'mod-1',
          targetUserId: 'target-1',
          reason: '   ',
          roomType: 'AUDIO_ROOM',
          originRoomId: 'room-1',
        }),
      ).rejects.toThrow('reason');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates the ban row, mirrors it into Redis with a 24h TTL, disconnects the target everywhere (after giving the room-specific kick notifications a head start), and audits it', async () => {
      jest.useFakeTimers();
      try {
        await service.banUser({
          moderatorId: 'mod-1',
          targetUserId: 'target-1',
          reason: 'harassment',
          roomType: 'AUDIO_ROOM',
          originRoomId: 'room-1',
        });

        expect(repo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            moderatorId: 'mod-1',
            targetUserId: 'target-1',
            reason: 'harassment',
            roomType: 'AUDIO_ROOM',
            originRoomId: 'room-1',
          }),
        );
        expect(redis.set).toHaveBeenCalledWith(
          'platform-ban:user:target-1',
          expect.any(String),
          'EX',
          86400,
        );
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ moderatorId: 'mod-1', action: 'BAN_ISSUED', targetUserId: 'target-1' }),
        );

        // Not called immediately — the room-specific kick flows (issued by the
        // calling controller and by this event's own listeners) get a head
        // start so their targeted "you were removed" notifications actually
        // reach the client before this blunt disconnect would sever it.
        expect(sockets.disconnectUserEverywhere).not.toHaveBeenCalled();
        jest.advanceTimersByTime(3000);
        expect(sockets.disconnectUserEverywhere).toHaveBeenCalledWith('target-1');
      } finally {
        jest.useRealTimers();
      }
    });

    it('threads an optional reportId through to the ban row when provided', async () => {
      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'room-1',
        reportId: 'report-1',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ reportId: 'report-1' }),
      );
    });

    it('omits reportId when the caller does not supply one (existing direct-ban callers)', async () => {
      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'room-1',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ reportId: null }),
      );
    });

    it('room teardown (DB flip + RoomEndedEvent) is complete by the time banUser() resolves — not fire-and-forget racing the caller\'s own refresh', async () => {
      prisma.audioRoom.findFirst.mockResolvedValueOnce({
        id: 'audio-room-1',
        createdAt: new Date(Date.now() - 120_000),
      });

      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'some-other-room',
      });
      // No flush/tick here on purpose: asserting immediately after banUser()
      // resolves is what proves the teardown isn't a `void`'d fire-and-forget
      // call that a caller's immediate re-fetch could race ahead of.

      expect(prisma.audioRoom.updateMany).toHaveBeenCalledWith({
        where: { ownerId: 'target-1', status: 'LIVE' },
        data: { status: 'OFFLINE', endedAt: expect.any(Date) },
      });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'audio_room.ended',
          payload: expect.objectContaining({
            roomId: 'audio-room-1',
            actorId: 'target-1',
            ownerId: 'target-1',
          }),
        }),
      );
    });

    it('publishes RoomClosedEvent for every live video room the banned user owns', async () => {
      prisma.videoRoom.findMany.mockResolvedValueOnce([
        { id: 'video-room-1', createdAt: new Date(Date.now() - 60_000) },
        { id: 'video-room-2', createdAt: new Date(Date.now() - 90_000) },
      ]);

      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'some-other-room',
      });

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'video_room.closed',
          payload: expect.objectContaining({ roomId: 'video-room-1', ownerId: 'target-1' }),
        }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'video_room.closed',
          payload: expect.objectContaining({ roomId: 'video-room-2', ownerId: 'target-1' }),
        }),
      );
    });

    it('does not publish a room-ended event when the banned user owns no currently-live room', async () => {
      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'some-other-room',
      });

      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.ended' }),
      );
      expect(bus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'video_room.closed' }),
      );
    });
  });

  describe('assertNotGloballyBanned', () => {
    it('does nothing when the Redis key is absent', async () => {
      redis.get.mockResolvedValueOnce(null);
      await expect(service.assertNotGloballyBanned('target-1')).resolves.toBeUndefined();
    });

    it('throws with the reason and expiry when banned', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ reason: 'harassment', expiresAt: '2026-08-19T00:00:00.000Z' }),
      );
      await expect(service.assertNotGloballyBanned('target-1')).rejects.toThrow(ForbiddenException);
      await expect(service.assertNotGloballyBanned('target-1')).rejects.toThrow(/harassment/);
    });
  });

  describe('unbanUser', () => {
    it('deletes the Redis key, flips the DB row to LIFTED, publishes domain event, and emits socket events', async () => {
      repo.findById.mockResolvedValueOnce({
        id: 'ban-1',
        status: 'ACTIVE',
        targetUserId: 'target-1',
        originRoomId: 'room-1',
        roomType: 'AUDIO_ROOM',
      });
      const result = await service.unbanUser('admin-1', 'ban-1');
      expect(redis.del).toHaveBeenCalledWith('platform-ban:user:target-1');
      expect(repo.lift).toHaveBeenCalledWith('ban-1', 'admin-1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'platform-moderation.user-unbanned',
          payload: expect.objectContaining({ targetUserId: 'target-1', moderatorId: 'admin-1' }),
        }),
      );
      expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
        'target-1',
        'room.unbanned',
        expect.objectContaining({ targetUserId: 'target-1', reason: 'lifted' }),
      );
      expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
        '/audio-room',
        'room-1',
        'room.unbanned',
        expect.objectContaining({ targetUserId: 'target-1', reason: 'lifted' }),
      );
      expect(result.status).toBe('LIFTED');
    });

    it('is idempotent — lifting an already-lifted ban does not error', async () => {
      repo.findById.mockResolvedValueOnce({ id: 'ban-1', status: 'LIFTED', targetUserId: 'target-1' });
      const result = await service.unbanUser('admin-1', 'ban-1');
      expect(repo.lift).not.toHaveBeenCalled();
      expect(result.status).toBe('LIFTED');
    });
  });
});
