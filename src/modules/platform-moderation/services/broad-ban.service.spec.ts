import { ForbiddenException } from '@nestjs/common';
import { BroadBanService } from './broad-ban.service';

describe('BroadBanService', () => {
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
  let service: BroadBanService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue({
        id: 'bb-1',
        roomId: 'room-1',
        ownerId: 'owner-1',
        reason: 'abuse',
        expiresAt: new Date('2026-08-19T00:00:00.000Z'),
      }),
      findById: jest.fn().mockResolvedValue({
        id: 'bb-1',
        status: 'ACTIVE',
        ownerId: 'owner-1',
        reason: 'abuse',
        roomId: 'room-1',
        roomType: 'AUDIO_ROOM',
        expiresAt: new Date('2026-08-19T00:00:00.000Z'),
      }),
      lift: jest.fn().mockResolvedValue({ id: 'bb-1', status: 'LIFTED' }),
      extend: jest
        .fn()
        .mockResolvedValue({ id: 'bb-1', expiresAt: new Date('2026-08-20T00:00:00.000Z') }),
      list: jest.fn().mockResolvedValue([[], 0]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    prisma = {
      audioRoom: {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: 'owner-1',
          createdAt: new Date('2026-08-18T22:00:00.000Z'),
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      videoRoom: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      liveStream: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new BroadBanService(
      repo as never,
      audit as never,
      redis as never,
      sockets as never,
      prisma as never,
      bus as never,
    );
  });

  describe('banBroad', () => {
    it('rejects an empty reason', async () => {
      await expect(
        service.banBroad({
          moderatorId: 'mod-1',
          roomId: 'room-1',
          roomType: 'AUDIO_ROOM',
          reason: '   ',
        }),
      ).rejects.toThrow('reason');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a room that no longer exists', async () => {
      prisma.audioRoom.findUnique.mockResolvedValue(null);
      await expect(
        service.banBroad({
          moderatorId: 'mod-1',
          roomId: 'room-1',
          roomType: 'AUDIO_ROOM',
          reason: 'abuse',
        }),
      ).rejects.toThrow('not found');
    });

    it('creates the ban row keyed to the room owner, sets a creation-only Redis flag, ends the room, and notifies everyone in it', async () => {
      await service.banBroad({
        moderatorId: 'mod-1',
        roomId: 'room-1',
        roomType: 'AUDIO_ROOM',
        reason: 'abuse',
        description: 'repeated abusive language',
        proofUrl: 'https://example.com/proof.png',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: 'room-1',
          roomType: 'AUDIO_ROOM',
          ownerId: 'owner-1',
          moderatorId: 'mod-1',
          reason: 'abuse',
          description: 'repeated abusive language',
          proofUrl: 'https://example.com/proof.png',
        }),
      );
      expect(redis.set).toHaveBeenCalledWith(
        'broad-ban:creation:owner-1',
        expect.any(String),
        'EX',
        86400,
      );
      expect(prisma.audioRoom.update).toHaveBeenCalledWith({
        where: { id: 'room-1' },
        data: expect.objectContaining({ status: 'OFFLINE' }),
      });
      expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
        '/audio-room',
        'room-1',
        'broad-ban.room-banned',
        expect.objectContaining({ sender: 'Soulzaa Official', reason: 'abuse' }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.ended' }),
      );
    });
  });

  describe('assertNotBroadBanned', () => {
    it('does nothing when there is no active creation ban', async () => {
      redis.get.mockResolvedValue(null);
      await expect(service.assertNotBroadBanned('owner-1')).resolves.toBeUndefined();
    });

    it('throws when the owner has an active creation ban', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          reason: 'abuse',
          expiresAt: '2026-08-19T00:00:00.000Z',
          roomId: 'room-1',
        }),
      );
      await expect(service.assertNotBroadBanned('owner-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('liftBroadBan', () => {
    it('clears the Redis flag and lifts the ban', async () => {
      const result = await service.liftBroadBan('admin-1', 'bb-1');
      expect(redis.del).toHaveBeenCalledWith('broad-ban:creation:owner-1');
      expect(repo.lift).toHaveBeenCalledWith('bb-1', 'admin-1');
      expect(result.status).toBe('LIFTED');
    });
  });

  describe('extendBroadBan', () => {
    it('pushes expiresAt forward, re-primes Redis, and notifies the owner directly', async () => {
      const result = await service.extendBroadBan('admin-1', 'bb-1', 24);
      expect(repo.extend).toHaveBeenCalledWith('bb-1', new Date('2026-08-20T00:00:00.000Z'));
      expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
        'owner-1',
        'broad-ban.room-banned',
        expect.objectContaining({ sender: 'Soulzaa Official', reason: 'abuse' }),
      );
      expect(result.expiresAt).toEqual(new Date('2026-08-20T00:00:00.000Z'));
    });
  });
});
