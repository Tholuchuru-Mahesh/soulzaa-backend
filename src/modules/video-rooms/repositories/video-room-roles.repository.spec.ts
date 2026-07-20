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
        findMany: jest.fn().mockResolvedValue([]),
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
});
