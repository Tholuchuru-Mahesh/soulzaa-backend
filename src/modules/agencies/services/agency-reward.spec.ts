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
    return { service: new AgencyRewardService(prisma), prisma, tx };
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
