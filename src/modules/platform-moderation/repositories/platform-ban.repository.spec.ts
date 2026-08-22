import { PlatformBanRepository } from './platform-ban.repository';

describe('PlatformBanRepository', () => {
  let prisma: { platformUserBan: Record<string, jest.Mock> };
  let repo: PlatformBanRepository;

  beforeEach(() => {
    prisma = {
      platformUserBan: {
        create: jest.fn().mockResolvedValue({ id: 'ban-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: 'ban-1', status: 'LIFTED' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    repo = new PlatformBanRepository(prisma as never);
  });

  it('create() writes a row with the given fields', async () => {
    await repo.create({
      targetUserId: 'u1',
      moderatorId: 'm1',
      reason: 'spam',
      roomType: 'AUDIO_ROOM',
      originRoomId: 'r1',
      expiresAt: new Date('2026-08-19T00:00:00Z'),
    });
    expect(prisma.platformUserBan.create).toHaveBeenCalledWith({
      data: {
        targetUserId: 'u1',
        moderatorId: 'm1',
        reason: 'spam',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'r1',
        expiresAt: new Date('2026-08-19T00:00:00Z'),
      },
    });
  });

  it('findActive() queries for ACTIVE status only', async () => {
    await repo.findActive('u1');
    expect(prisma.platformUserBan.findFirst).toHaveBeenCalledWith({
      where: { targetUserId: 'u1', status: 'ACTIVE' },
    });
  });

  it('lift() flips status to LIFTED and stamps liftedBy/liftedAt', async () => {
    await repo.lift('ban-1', 'admin-1');
    expect(prisma.platformUserBan.update).toHaveBeenCalledWith({
      where: { id: 'ban-1' },
      data: { status: 'LIFTED', liftedBy: 'admin-1', liftedAt: expect.any(Date) },
    });
  });

  it('extends an existing ban to a new expiry', async () => {
    prisma.platformUserBan.update.mockResolvedValue({
      id: 'ban-1',
      expiresAt: new Date('2026-08-20T00:00:00.000Z'),
    });
    const result = await repo.extend('ban-1', new Date('2026-08-20T00:00:00.000Z'));
    expect(prisma.platformUserBan.update).toHaveBeenCalledWith({
      where: { id: 'ban-1' },
      data: { expiresAt: new Date('2026-08-20T00:00:00.000Z') },
    });
    expect(result.expiresAt).toEqual(new Date('2026-08-20T00:00:00.000Z'));
  });
});
