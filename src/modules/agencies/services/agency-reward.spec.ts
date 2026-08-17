import { NotFoundException } from '@nestjs/common';
import { AgencyRewardService } from './agency-reward.service';

/**
 * Distribution moves stock and grants an item, so the properties that matter
 * are: it cannot overdraw the shelf, it cannot reach a non-member, it cannot
 * send twice for one tap, and an Assigned reward must not be giftable.
 */
describe('AgencyRewardService.distribute', () => {
  const AGENCY = 'agency-1';
  const MEMBER = 'member-1';

  function build(shelf: Record<string, unknown> | null = null) {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      agencyRewardInventory: {
        findFirst: jest.fn().mockResolvedValue(shelf),
        update: jest.fn().mockResolvedValue({}),
      },
      backpackItem: { create: jest.fn().mockResolvedValue({ id: 'bp-1' }) },
      backpackLog: { create: jest.fn().mockResolvedValue({}) },
      agencyRewardDistribution: { create: jest.fn().mockImplementation((a: any) => a.data) },
    };
    const prisma: any = {
      agencyRewardDistribution: { findUnique: jest.fn().mockResolvedValue(null) },
      agencyRelationship: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
      },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };
    const profiles = { resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()) };
    return { service: new AgencyRewardService(prisma, profiles as never), prisma, tx };
  }

  const shelfRow = {
    id: 'inv-1',
    agencyId: AGENCY,
    itemType: 'FRAME',
    refId: 'frame-9',
    name: 'Golden Frame',
    quantity: 5,
    expiresAt: null,
  };

  const base = {
    inventoryId: 'inv-1',
    recipientId: MEMBER,
    quantity: 1,
    idempotencyKey: 'key-1',
  };

  it('refuses a recipient who is not a member of the agency', async () => {
    const { service, prisma, tx } = build(shelfRow);
    prisma.agencyRelationship.findUnique.mockResolvedValue(null);

    await expect(service.distribute(AGENCY, base)).rejects.toBeInstanceOf(NotFoundException);
    // Nothing is decremented or granted.
    expect(tx.agencyRewardInventory.update).not.toHaveBeenCalled();
    expect(tx.backpackItem.create).not.toHaveBeenCalled();
  });

  it('refuses a released member', async () => {
    const { service, prisma } = build(shelfRow);
    prisma.agencyRelationship.findUnique.mockResolvedValue({ status: 'ENDED' });

    await expect(service.distribute(AGENCY, base)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('will not send more than the shelf holds', async () => {
    const { service, tx } = build({ ...shelfRow, quantity: 2 });

    await expect(service.distribute(AGENCY, { ...base, quantity: 3 })).rejects.toMatchObject({
      message: expect.stringContaining('Only 2'),
    });
    expect(tx.backpackItem.create).not.toHaveBeenCalled();
  });

  it('locks the shelf row before reading the balance', async () => {
    const { service, tx } = build(shelfRow);

    await service.distribute(AGENCY, base);

    // Without the lock two concurrent sends both see enough stock.
    expect(tx.$queryRaw).toHaveBeenCalled();
    const lockCallOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    const readCallOrder = tx.agencyRewardInventory.findFirst.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(readCallOrder);
  });

  it('grants an ASSIGNED reward as non-transferable', async () => {
    const { service, tx } = build(shelfRow);

    await service.distribute(AGENCY, { ...base, kind: 'ASSIGNED' });

    // The whole point of an Assigned reward: permanently bound, never gifted,
    // traded or sold onward.
    expect(tx.backpackItem.create.mock.calls[0][0].data.transferable).toBe(false);
    expect(tx.backpackItem.create.mock.calls[0][0].data.source).toBe('AGENCY');
  });

  it('grants an OWNED reward as transferable', async () => {
    const { service, tx } = build(shelfRow);

    await service.distribute(AGENCY, { ...base, kind: 'OWNED' });

    expect(tx.backpackItem.create.mock.calls[0][0].data.transferable).toBe(true);
  });

  it('defaults to ASSIGNED when no kind is given', async () => {
    const { service, tx } = build(shelfRow);

    await service.distribute(AGENCY, base);

    // The safer default: a reward that cannot be passed on is recoverable as
    // a policy decision; one already gifted onward is not.
    expect(tx.backpackItem.create.mock.calls[0][0].data.transferable).toBe(false);
  });

  it('returns the original send on a replayed key rather than sending twice', async () => {
    const { service, prisma, tx } = build(shelfRow);
    prisma.agencyRewardDistribution.findUnique.mockResolvedValue({ id: 'dist-1' });

    const res = await service.distribute(AGENCY, base);

    expect(res).toMatchObject({ id: 'dist-1' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.backpackItem.create).not.toHaveBeenCalled();
  });

  it('refuses a shelf row belonging to another agency', async () => {
    // findFirst is scoped by agencyId, so another agency's row simply is not
    // found rather than being read and then rejected.
    const { service, tx } = build(null);

    await expect(service.distribute(AGENCY, base)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.agencyRewardInventory.findFirst).toHaveBeenCalledWith({
      where: { id: 'inv-1', agencyId: AGENCY },
    });
  });

  it('rejects a zero or negative quantity before touching anything', async () => {
    const { service, prisma } = build(shelfRow);

    await expect(service.distribute(AGENCY, { ...base, quantity: 0 })).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('will not distribute an expired reward', async () => {
    const { service, tx } = build({
      ...shelfRow,
      expiresAt: new Date('2020-01-01'),
    });

    await expect(service.distribute(AGENCY, base)).rejects.toMatchObject({
      message: expect.stringContaining('expired'),
    });
    expect(tx.backpackItem.create).not.toHaveBeenCalled();
  });
});

/**
 * The history screen and the distribution screen's header.
 *
 * Both read the same table, so the rule that matters most is scoping: an
 * agency sees what it sent, never what a rival gave the same member.
 */
describe('AgencyRewardService reads', () => {
  const AGENCY = 'agency-1';

  function build(rewards: Record<string, unknown>[] = []) {
    const prisma: any = {
      agencyRewardDistribution: {
        findMany: jest.fn().mockResolvedValue(rewards),
        count: jest.fn().mockResolvedValue(rewards.length),
      },
    };
    const profiles = {
      resolvePublicIdentities: jest
        .fn()
        .mockResolvedValue(
          new Map([['u1', { displayName: 'balayya', avatarUrl: 'https://cdn/a.png' }]]),
        ),
    };
    const service = new AgencyRewardService(prisma, profiles as never);
    return { service, prisma, profiles };
  }

  function rows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `r${i}`,
      recipientId: 'u1',
      itemType: 'MEDAL',
      name: 'Premium medal',
      quantity: 1,
      kind: 'ASSIGNED',
      note: null,
      createdAt: new Date('2026-06-20T00:00:00Z'),
    }));
  }

  describe('listDistributions', () => {
    it('scopes to the calling agency', async () => {
      const { service, prisma } = build(rows(1));

      await service.listDistributions(AGENCY);

      expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agencyId: AGENCY }) }),
      );
    });

    it('resolves the recipient identity in one bulk call', async () => {
      const { service, profiles } = build(rows(3));

      const res = await service.listDistributions(AGENCY);

      expect(profiles.resolvePublicIdentities).toHaveBeenCalledTimes(1);
      expect(res.items[0].recipientName).toBe('balayya');
      expect(res.items[0].recipientAvatarUrl).toBe('https://cdn/a.png');
    });

    it('returns a null identity rather than failing when the profile seam has nothing', async () => {
      const { service, profiles } = build(rows(1));
      profiles.resolvePublicIdentities.mockResolvedValue(new Map());

      const res = await service.listDistributions(AGENCY);

      expect(res.items[0].recipientName).toBeNull();
      expect(res.items[0].recipientAvatarUrl).toBeNull();
    });

    it('pages', async () => {
      const { service, prisma } = build(rows(20));
      prisma.agencyRewardDistribution.count.mockResolvedValue(45);

      const res = await service.listDistributions(AGENCY, { page: 2, limit: 20 });

      expect(res).toMatchObject({ page: 2, limit: 20, total: 45, totalPages: 3 });
      expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
    });

    it('applies no date bound for range=all', async () => {
      const { service, prisma } = build(rows(1));

      await service.listDistributions(AGENCY, { range: 'all' });

      expect(
        prisma.agencyRewardDistribution.findMany.mock.calls[0][0].where.createdAt,
      ).toBeUndefined();
    });

    it.each(['today', 'week', 'month'] as const)('bounds range=%s', async (range) => {
      const { service, prisma } = build(rows(1));

      await service.listDistributions(AGENCY, { range });

      const where = prisma.agencyRewardDistribution.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte).toBeInstanceOf(Date);
      expect(where.createdAt.gte.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('clamps an absurd page size', async () => {
      const { service, prisma } = build(rows(1));

      await service.listDistributions(AGENCY, { limit: 100_000 });

      expect(prisma.agencyRewardDistribution.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('getStats', () => {
    it('counts all-time, today and this month, scoped to the agency', async () => {
      const { service, prisma } = build();
      prisma.agencyRewardDistribution.count
        .mockResolvedValueOnce(1248)
        .mockResolvedValueOnce(24)
        .mockResolvedValueOnce(378);

      const res = await service.getStats(AGENCY);

      expect(res).toEqual({ totalSent: 1248, today: 24, thisMonth: 378 });
      for (const call of prisma.agencyRewardDistribution.count.mock.calls) {
        expect(call[0].where.agencyId).toBe(AGENCY);
      }
    });

    it('reports real zeros for an agency that has sent nothing', async () => {
      // Zero is the true answer here, not a missing one.
      const { service, prisma } = build();
      prisma.agencyRewardDistribution.count.mockResolvedValue(0);

      expect(await service.getStats(AGENCY)).toEqual({ totalSent: 0, today: 0, thisMonth: 0 });
    });
  });
});
