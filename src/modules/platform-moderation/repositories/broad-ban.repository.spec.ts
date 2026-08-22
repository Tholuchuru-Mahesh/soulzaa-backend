// src/modules/platform-moderation/repositories/broad-ban.repository.spec.ts
import { BroadBanRepository } from './broad-ban.repository';

describe('BroadBanRepository', () => {
  let prisma: { broadBan: Record<string, jest.Mock> };
  let repo: BroadBanRepository;

  beforeEach(() => {
    prisma = {
      broadBan: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    repo = new BroadBanRepository(prisma as never);
  });

  it('creates a broad ban row', async () => {
    prisma.broadBan.create.mockResolvedValue({ id: 'bb-1' });
    const input = {
      roomId: 'room-1',
      roomType: 'AUDIO_ROOM' as const,
      ownerId: 'owner-1',
      moderatorId: 'mod-1',
      reason: 'abuse',
      description: 'repeated abusive language',
      proofUrl: 'https://example.com/proof.png',
      expiresAt: new Date('2026-08-19T00:00:00.000Z'),
    };
    const result = await repo.create(input);
    expect(prisma.broadBan.create).toHaveBeenCalledWith({ data: input });
    expect(result.id).toBe('bb-1');
  });

  it('finds a broad ban by id', async () => {
    prisma.broadBan.findUnique.mockResolvedValue({ id: 'bb-1' });
    const result = await repo.findById('bb-1');
    expect(prisma.broadBan.findUnique).toHaveBeenCalledWith({ where: { id: 'bb-1' } });
    expect(result?.id).toBe('bb-1');
  });

  it('lifts a broad ban', async () => {
    prisma.broadBan.update.mockResolvedValue({ id: 'bb-1', status: 'LIFTED' });
    const result = await repo.lift('bb-1', 'admin-1');
    expect(prisma.broadBan.update).toHaveBeenCalledWith({
      where: { id: 'bb-1' },
      data: expect.objectContaining({ status: 'LIFTED', liftedBy: 'admin-1' }),
    });
    expect(result.status).toBe('LIFTED');
  });

  it('extends a broad ban to a new expiry', async () => {
    prisma.broadBan.update.mockResolvedValue({ id: 'bb-1', expiresAt: new Date('2026-08-20T00:00:00.000Z') });
    const result = await repo.extend('bb-1', new Date('2026-08-20T00:00:00.000Z'));
    expect(prisma.broadBan.update).toHaveBeenCalledWith({
      where: { id: 'bb-1' },
      data: { expiresAt: new Date('2026-08-20T00:00:00.000Z') },
    });
    expect(result.expiresAt).toEqual(new Date('2026-08-20T00:00:00.000Z'));
  });

  it('lists broad bans with pagination', async () => {
    prisma.broadBan.findMany.mockResolvedValue([{ id: 'bb-1' }]);
    prisma.broadBan.count.mockResolvedValue(1);
    const [rows, total] = await repo.list({ status: 'ACTIVE' as const }, 0, 20);
    expect(prisma.broadBan.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      skip: 0,
      take: 20,
      orderBy: { bannedAt: 'desc' },
    });
    expect(rows).toHaveLength(1);
    expect(total).toBe(1);
  });
});
