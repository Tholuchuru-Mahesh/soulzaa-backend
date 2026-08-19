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
    sockets = { disconnectUserEverywhere: jest.fn() };
    prisma = {
      audioRoom: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      videoRoom: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      liveStream: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    service = new PlatformBanService(
      repo as never,
      audit as never,
      redis as never,
      sockets as never,
      prisma as never,
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

    it('creates the ban row, mirrors it into Redis with a 24h TTL, disconnects the target everywhere, and audits it', async () => {
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
      expect(sockets.disconnectUserEverywhere).toHaveBeenCalledWith('target-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ moderatorId: 'mod-1', action: 'BAN_ISSUED', targetUserId: 'target-1' }),
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
    it('deletes the Redis key and flips the DB row to LIFTED', async () => {
      const result = await service.unbanUser('admin-1', 'ban-1');
      expect(redis.del).toHaveBeenCalledWith('platform-ban:user:target-1');
      expect(repo.lift).toHaveBeenCalledWith('ban-1', 'admin-1');
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
