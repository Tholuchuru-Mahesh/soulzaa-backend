import { VideoRoomMemberRole } from '@prisma/client';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomRolesRepository } from './video-room-roles.repository';

describe('VideoRoomRolesRepository', () => {
  let prisma: any;
  let repo: VideoRoomRolesRepository;

  beforeEach(() => {
    prisma = {
      videoRoomRole: {
        upsert: jest.fn().mockResolvedValue({ id: 'g1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    repo = new VideoRoomRolesRepository(prisma as unknown as PrismaService);
  });

  it('grant upserts on the composite (roomId,userId) and stamps audit', async () => {
    await repo.grant({
      roomId: 'r1',
      userId: 'u1',
      role: VideoRoomMemberRole.ADMIN,
      grantedBy: 'owner',
    });
    const arg = prisma.videoRoomRole.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ roomId_userId: { roomId: 'r1', userId: 'u1' } });
    expect(arg.create).toMatchObject({
      role: VideoRoomMemberRole.ADMIN,
      grantedBy: 'owner',
      createdBy: 'owner',
      updatedBy: 'owner',
      expiresAt: null,
    });
    expect(arg.update).toMatchObject({ role: VideoRoomMemberRole.ADMIN, updatedBy: 'owner' });
  });

  it('grant carries an explicit expiry when provided', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    await repo.grant({
      roomId: 'r1',
      userId: 'u1',
      role: VideoRoomMemberRole.MODERATOR,
      grantedBy: 'owner',
      expiresAt,
    });
    expect(prisma.videoRoomRole.upsert.mock.calls[0][0].create.expiresAt).toBe(expiresAt);
  });

  it('revoke deletes the grant and returns the affected count', async () => {
    const count = await repo.revoke('r1', 'u1');
    expect(prisma.videoRoomRole.deleteMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', userId: 'u1' },
    });
    expect(count).toBe(1);
  });

  // VR-7: `expiresAt` has existed since VR-1 but nothing ever read it, so an
  // expired temporary ADMIN kept full powers indefinitely. These pin the fix.
  describe('expiry-aware reads', () => {
    const NOW = new Date('2026-07-21T12:00:00.000Z');

    it('findActive filters on the not-expired predicate', async () => {
      await expect(repo.findActive('r1', 'u1', NOW)).resolves.toBeNull();
      expect(prisma.videoRoomRole.findFirst).toHaveBeenCalledWith({
        where: {
          roomId: 'r1',
          userId: 'u1',
          OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
        },
      });
    });

    it('findActive returns a permanent grant', async () => {
      const grant = { id: 'g1', roomId: 'r1', userId: 'u1', expiresAt: null };
      prisma.videoRoomRole.findFirst.mockResolvedValue(grant);
      await expect(repo.findActive('r1', 'u1', NOW)).resolves.toBe(grant);
    });

    it('listActiveByRoom applies the same predicate, oldest grant first', async () => {
      await repo.listActiveByRoom('r1', NOW);
      expect(prisma.videoRoomRole.findMany).toHaveBeenCalledWith({
        where: { roomId: 'r1', OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }] },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('countByRole counts only active grants of one role', async () => {
      prisma.videoRoomRole.count.mockResolvedValue(24);
      await expect(repo.countByRole('r1', VideoRoomMemberRole.ADMIN, NOW)).resolves.toBe(24);
      expect(prisma.videoRoomRole.count).toHaveBeenCalledWith({
        where: {
          roomId: 'r1',
          role: VideoRoomMemberRole.ADMIN,
          OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
        },
      });
    });

    it('listExpired returns lapsed grants, oldest first, capped', async () => {
      await repo.listExpired(NOW, 100);
      expect(prisma.videoRoomRole.findMany).toHaveBeenCalledWith({
        where: { expiresAt: { not: null, lte: NOW } },
        orderBy: { expiresAt: 'asc' },
        take: 100,
      });
    });

    it('deleteByIds short-circuits on an empty list', async () => {
      await expect(repo.deleteByIds([])).resolves.toBe(0);
      expect(prisma.videoRoomRole.deleteMany).not.toHaveBeenCalled();
    });

    it('deleteByIds removes the given grants', async () => {
      prisma.videoRoomRole.deleteMany.mockResolvedValue({ count: 2 });
      await expect(repo.deleteByIds(['a', 'b'])).resolves.toBe(2);
      expect(prisma.videoRoomRole.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] } },
      });
    });
  });
});
