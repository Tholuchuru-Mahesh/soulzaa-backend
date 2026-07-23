import {
  VideoRoomModerationActionType,
  VideoRoomModerationMuteType,
  VideoRoomModerationStatus,
} from '@prisma/client';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import type { RedisClient } from 'src/infra/redis/redis.constants';
import { blocksMirrorKey, mutesMirrorKey } from '../constants/video-room-moderation.constants';
import { VideoRoomModerationRepository } from './video-room-moderation.repository';

describe('VideoRoomModerationRepository', () => {
  let prisma: any;
  let redis: any;
  let repo: VideoRoomModerationRepository;

  beforeEach(() => {
    prisma = {
      videoRoomMute: {
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: 'm1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      videoRoomBlock: {
        create: jest.fn().mockResolvedValue({ id: 'b1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: 'b1' }),
      },
      videoRoomModerationAction: {
        create: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((arg: any) => Promise.all(arg)),
    };
    redis = {
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      sismember: jest.fn().mockResolvedValue(0),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    repo = new VideoRoomModerationRepository(
      prisma as unknown as PrismaService,
      redis as unknown as RedisClient,
    );
  });

  it('createMute stamps audit from the moderator', async () => {
    await repo.createMute({
      roomId: 'r1',
      userId: 'u1',
      moderatorId: 'mod',
      type: VideoRoomModerationMuteType.TEMPORARY,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const data = prisma.videoRoomMute.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      roomId: 'r1',
      moderatorId: 'mod',
      createdBy: 'mod',
      updatedBy: 'mod',
    });
  });

  it('findActiveMute filters to ACTIVE status', async () => {
    await repo.findActiveMute('r1', 'u1');
    expect(prisma.videoRoomMute.findFirst).toHaveBeenCalledWith({
      where: { roomId: 'r1', userId: 'u1', status: VideoRoomModerationStatus.ACTIVE },
    });
  });

  it('liftMute records who lifted it and when', async () => {
    await repo.liftMute('m1', 'mod2');
    const data = prisma.videoRoomMute.update.mock.calls[0][0].data;
    expect(data.status).toBe(VideoRoomModerationStatus.LIFTED);
    expect(data.liftedBy).toBe('mod2');
    expect(data.liftedAt).toBeInstanceOf(Date);
  });

  it('expireMutes only touches ACTIVE mutes past expiry', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const count = await repo.expireMutes(now);
    expect(prisma.videoRoomMute.updateMany).toHaveBeenCalledWith({
      where: { status: VideoRoomModerationStatus.ACTIVE, expiresAt: { lt: now } },
      data: { status: VideoRoomModerationStatus.EXPIRED },
    });
    expect(count).toBe(3);
  });

  it('findExpiredMutes finds ACTIVE mutes with a past, non-null expiry (default take 200)', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await repo.findExpiredMutes(now);
    expect(prisma.videoRoomMute.findMany).toHaveBeenCalledWith({
      where: { status: VideoRoomModerationStatus.ACTIVE, expiresAt: { not: null, lt: now } },
      take: 200,
      orderBy: { expiresAt: 'asc' },
    });
  });

  it('findExpiredMutes honours a custom take', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await repo.findExpiredMutes(now, 50);
    expect(prisma.videoRoomMute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('findActiveBlock is the join-time gate (ACTIVE only)', async () => {
    await repo.findActiveBlock('r1', 'u1');
    expect(prisma.videoRoomBlock.findFirst).toHaveBeenCalledWith({
      where: { roomId: 'r1', userId: 'u1', status: VideoRoomModerationStatus.ACTIVE },
    });
  });

  it('appendAction writes an append-only audit row (no id/update path)', async () => {
    await repo.appendAction({
      roomId: 'r1',
      moderatorId: 'mod',
      targetUserId: 'u1',
      action: VideoRoomModerationActionType.BLOCK,
    });
    expect(prisma.videoRoomModerationAction.create).toHaveBeenCalledWith({
      data: {
        roomId: 'r1',
        moderatorId: 'mod',
        targetUserId: 'u1',
        action: VideoRoomModerationActionType.BLOCK,
        reason: null,
        metadata: undefined,
      },
    });
  });

  // ---- Paginated reads (VR-16 Task 17) ----

  it('listActiveMutes returns a $transaction([findMany, count]) tuple ordered createdAt desc', async () => {
    await repo.listActiveMutes('r1', 0, 20);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.videoRoomMute.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', status: VideoRoomModerationStatus.ACTIVE },
      skip: 0,
      take: 20,
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.videoRoomMute.count).toHaveBeenCalledWith({
      where: { roomId: 'r1', status: VideoRoomModerationStatus.ACTIVE },
    });
  });

  it('listActiveMutes scopes to userId when provided', async () => {
    await repo.listActiveMutes('r1', 0, 20, 'u1');
    expect(prisma.videoRoomMute.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roomId: 'r1', status: VideoRoomModerationStatus.ACTIVE, userId: 'u1' },
      }),
    );
  });

  it('listActiveBlocks returns a $transaction([findMany, count]) tuple ordered createdAt desc', async () => {
    await repo.listActiveBlocks('r1', 0, 20);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.videoRoomBlock.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', status: VideoRoomModerationStatus.ACTIVE },
      skip: 0,
      take: 20,
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.videoRoomBlock.count).toHaveBeenCalledWith({
      where: { roomId: 'r1', status: VideoRoomModerationStatus.ACTIVE },
    });
  });

  it('listActiveBlocks scopes to userId when provided', async () => {
    await repo.listActiveBlocks('r1', 0, 20, 'u1');
    expect(prisma.videoRoomBlock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roomId: 'r1', status: VideoRoomModerationStatus.ACTIVE, userId: 'u1' },
      }),
    );
  });

  it('listActions returns a $transaction([findMany, count]) tuple ordered createdAt desc', async () => {
    await repo.listActions('r1', 0, 20);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.videoRoomModerationAction.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1' },
      skip: 0,
      take: 20,
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.videoRoomModerationAction.count).toHaveBeenCalledWith({
      where: { roomId: 'r1' },
    });
  });

  it('listActions scopes to targetUserId when provided', async () => {
    await repo.listActions('r1', 0, 20, 'u1');
    expect(prisma.videoRoomModerationAction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { roomId: 'r1', targetUserId: 'u1' } }),
    );
    expect(prisma.videoRoomModerationAction.count).toHaveBeenCalledWith({
      where: { roomId: 'r1', targetUserId: 'u1' },
    });
  });

  it('exposes NO ban capability (Video Room has no ban feature)', () => {
    expect((repo as any).createBan).toBeUndefined();
    expect((repo as any).findActiveBan).toBeUndefined();
    expect(prisma.videoRoomBan).toBeUndefined();
  });

  // ---- Redis mirror helpers (VR-16 Task 6) ----

  describe('mute mirror', () => {
    it('addMuteMirror SADDs the mirror set and sets a per-user marker (no ttl)', async () => {
      await repo.addMuteMirror('r1', 'u1');
      expect(redis.sadd).toHaveBeenCalledWith(mutesMirrorKey('r1'), 'u1');
      expect(redis.set).toHaveBeenCalledWith(`${mutesMirrorKey('r1')}:u1`, '1');
    });

    it('addMuteMirror sets a PX ttl on the per-user marker when ttlMs is given', async () => {
      await repo.addMuteMirror('r1', 'u1', 60_000);
      expect(redis.set).toHaveBeenCalledWith(`${mutesMirrorKey('r1')}:u1`, '1', 'PX', 60_000);
    });

    it('removeMuteMirror SREMs the mirror set and deletes the per-user marker', async () => {
      await repo.removeMuteMirror('r1', 'u1');
      expect(redis.srem).toHaveBeenCalledWith(mutesMirrorKey('r1'), 'u1');
      expect(redis.del).toHaveBeenCalledWith(`${mutesMirrorKey('r1')}:u1`);
    });

    it('isMutedMirror reflects SISMEMBER on the mirror set', async () => {
      redis.sismember.mockResolvedValueOnce(1);
      await expect(repo.isMutedMirror('r1', 'u1')).resolves.toBe(true);
      expect(redis.sismember).toHaveBeenCalledWith(mutesMirrorKey('r1'), 'u1');

      redis.sismember.mockResolvedValueOnce(0);
      await expect(repo.isMutedMirror('r1', 'u1')).resolves.toBe(false);
    });

    it('full lifecycle against an in-memory set: add -> true, remove -> false', async () => {
      const store = new Set<string>();
      redis.sadd.mockImplementation((_key: string, member: string) => {
        store.add(member);
        return Promise.resolve(1);
      });
      redis.srem.mockImplementation((_key: string, member: string) => {
        store.delete(member);
        return Promise.resolve(1);
      });
      redis.sismember.mockImplementation((_key: string, member: string) =>
        Promise.resolve(store.has(member) ? 1 : 0),
      );

      await repo.addMuteMirror('r', 'u');
      await expect(repo.isMutedMirror('r', 'u')).resolves.toBe(true);

      await repo.removeMuteMirror('r', 'u');
      await expect(repo.isMutedMirror('r', 'u')).resolves.toBe(false);
    });
  });

  describe('block mirror', () => {
    it('addBlockMirror SADDs the mirror set and sets a per-user marker (no ttl)', async () => {
      await repo.addBlockMirror('r1', 'u1');
      expect(redis.sadd).toHaveBeenCalledWith(blocksMirrorKey('r1'), 'u1');
      expect(redis.set).toHaveBeenCalledWith(`${blocksMirrorKey('r1')}:u1`, '1');
    });

    it('addBlockMirror sets a PX ttl on the per-user marker when ttlMs is given', async () => {
      await repo.addBlockMirror('r1', 'u1', 120_000);
      expect(redis.set).toHaveBeenCalledWith(`${blocksMirrorKey('r1')}:u1`, '1', 'PX', 120_000);
    });

    it('removeBlockMirror SREMs the mirror set and deletes the per-user marker', async () => {
      await repo.removeBlockMirror('r1', 'u1');
      expect(redis.srem).toHaveBeenCalledWith(blocksMirrorKey('r1'), 'u1');
      expect(redis.del).toHaveBeenCalledWith(`${blocksMirrorKey('r1')}:u1`);
    });

    it('isBlockedMirror reflects SISMEMBER on the mirror set', async () => {
      redis.sismember.mockResolvedValueOnce(1);
      await expect(repo.isBlockedMirror('r1', 'u1')).resolves.toBe(true);
      expect(redis.sismember).toHaveBeenCalledWith(blocksMirrorKey('r1'), 'u1');

      redis.sismember.mockResolvedValueOnce(0);
      await expect(repo.isBlockedMirror('r1', 'u1')).resolves.toBe(false);
    });

    it('full lifecycle against an in-memory set: add -> true, remove -> false', async () => {
      const store = new Set<string>();
      redis.sadd.mockImplementation((_key: string, member: string) => {
        store.add(member);
        return Promise.resolve(1);
      });
      redis.srem.mockImplementation((_key: string, member: string) => {
        store.delete(member);
        return Promise.resolve(1);
      });
      redis.sismember.mockImplementation((_key: string, member: string) =>
        Promise.resolve(store.has(member) ? 1 : 0),
      );

      await repo.addBlockMirror('r', 'u');
      await expect(repo.isBlockedMirror('r', 'u')).resolves.toBe(true);

      await repo.removeBlockMirror('r', 'u');
      await expect(repo.isBlockedMirror('r', 'u')).resolves.toBe(false);
    });
  });

  // ---- Positive-only fast-path guards (I4 fix) ----
  //
  // DB stays authoritative: a mirror HIT short-circuits (skip the DB round
  // trip), but a mirror MISS always falls through to the DB find — a miss is
  // never trusted on its own as "not blocked/muted".

  describe('isActivelyBlocked', () => {
    it('returns true on a mirror hit WITHOUT calling the DB', async () => {
      redis.sismember.mockResolvedValueOnce(1);
      await expect(repo.isActivelyBlocked('r1', 'u1')).resolves.toBe(true);
      expect(redis.sismember).toHaveBeenCalledWith(blocksMirrorKey('r1'), 'u1');
      expect(prisma.videoRoomBlock.findFirst).not.toHaveBeenCalled();
    });

    it('falls through to the DB on a mirror miss and returns the DB truth (found)', async () => {
      redis.sismember.mockResolvedValueOnce(0);
      prisma.videoRoomBlock.findFirst.mockResolvedValueOnce({ id: 'b1' });
      await expect(repo.isActivelyBlocked('r1', 'u1')).resolves.toBe(true);
      expect(prisma.videoRoomBlock.findFirst).toHaveBeenCalledWith({
        where: { roomId: 'r1', userId: 'u1', status: VideoRoomModerationStatus.ACTIVE },
      });
    });

    it('falls through to the DB on a mirror miss and returns the DB truth (not found)', async () => {
      redis.sismember.mockResolvedValueOnce(0);
      prisma.videoRoomBlock.findFirst.mockResolvedValueOnce(null);
      await expect(repo.isActivelyBlocked('r1', 'u1')).resolves.toBe(false);
    });
  });

  describe('isActivelyMuted', () => {
    it('returns true on a mirror hit WITHOUT calling the DB', async () => {
      redis.sismember.mockResolvedValueOnce(1);
      await expect(repo.isActivelyMuted('r1', 'u1')).resolves.toBe(true);
      expect(redis.sismember).toHaveBeenCalledWith(mutesMirrorKey('r1'), 'u1');
      expect(prisma.videoRoomMute.findFirst).not.toHaveBeenCalled();
    });

    it('falls through to the DB on a mirror miss and returns the DB truth (found)', async () => {
      redis.sismember.mockResolvedValueOnce(0);
      prisma.videoRoomMute.findFirst.mockResolvedValueOnce({ id: 'm1' });
      await expect(repo.isActivelyMuted('r1', 'u1')).resolves.toBe(true);
      expect(prisma.videoRoomMute.findFirst).toHaveBeenCalledWith({
        where: { roomId: 'r1', userId: 'u1', status: VideoRoomModerationStatus.ACTIVE },
      });
    });

    it('falls through to the DB on a mirror miss and returns the DB truth (not found)', async () => {
      redis.sismember.mockResolvedValueOnce(0);
      prisma.videoRoomMute.findFirst.mockResolvedValueOnce(null);
      await expect(repo.isActivelyMuted('r1', 'u1')).resolves.toBe(false);
    });
  });
});
