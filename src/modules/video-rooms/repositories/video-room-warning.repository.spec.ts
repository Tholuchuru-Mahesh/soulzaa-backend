import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomWarningRepository } from './video-room-warning.repository';

describe('VideoRoomWarningRepository', () => {
  let prisma: any;
  let repo: VideoRoomWarningRepository;

  beforeEach(() => {
    prisma = {
      videoRoomWarning: {
        create: jest.fn().mockResolvedValue({ id: 'w1' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((arg: any) => Promise.all(arg)),
    };
    repo = new VideoRoomWarningRepository(prisma as unknown as PrismaService);
  });

  it('create writes a warning with audit cols from the moderator', async () => {
    await repo.create({
      roomId: 'r1',
      userId: 'u1',
      moderatorId: 'mod1',
      reason: 'spamming chat',
    });
    expect(prisma.videoRoomWarning.create).toHaveBeenCalledWith({
      data: {
        roomId: 'r1',
        userId: 'u1',
        moderatorId: 'mod1',
        reason: 'spamming chat',
        createdBy: 'mod1',
        updatedBy: 'mod1',
      },
    });
  });

  it('create carries an optional metadata payload through', async () => {
    await repo.create({
      roomId: 'r1',
      userId: 'u1',
      moderatorId: 'mod1',
      reason: 'spamming chat',
      metadata: { source: 'auto' },
    });
    const data = prisma.videoRoomWarning.create.mock.calls[0][0].data;
    expect(data.metadata).toEqual({ source: 'auto' });
  });

  it('list returns a $transaction([findMany, count]) tuple ordered createdAt desc', async () => {
    await repo.list('r1', { skip: 0, take: 20 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.videoRoomWarning.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1' },
      skip: 0,
      take: 20,
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.videoRoomWarning.count).toHaveBeenCalledWith({ where: { roomId: 'r1' } });
  });

  it('list scopes to userId when provided', async () => {
    await repo.list('r1', { skip: 0, take: 20, userId: 'u1' });
    expect(prisma.videoRoomWarning.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { roomId: 'r1', userId: 'u1' } }),
    );
    expect(prisma.videoRoomWarning.count).toHaveBeenCalledWith({
      where: { roomId: 'r1', userId: 'u1' },
    });
  });

  it('count calls prisma.videoRoomWarning.count scoped to room + user', async () => {
    prisma.videoRoomWarning.count.mockResolvedValue(4);
    await expect(repo.count('r1', 'u1')).resolves.toBe(4);
    expect(prisma.videoRoomWarning.count).toHaveBeenCalledWith({
      where: { roomId: 'r1', userId: 'u1' },
    });
  });
});
