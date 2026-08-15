import { NotFoundException } from '@nestjs/common';
import { AgencyMemberService } from './agency-member.service';

/**
 * The rule these cover: an agency sees its own members and nobody else's.
 *
 * Both routes derive the agency from the JWT, so the only way to reach another
 * agency's user is by guessing a uuid — which is why the detail route proves
 * membership before it reads anything, and the list searches within the member
 * set rather than across all users.
 */
describe('AgencyMemberService', () => {
  const AGENCY = 'agency-1';
  const MEMBER = 'member-1';

  function build(overrides: Record<string, unknown> = {}) {
    const prisma: any = {
      agencyRelationship: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      user: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
      wallet: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
      userSession: { findMany: jest.fn().mockResolvedValue([]) },
      giftTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _count: 0, _sum: { totalCoinValue: null } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      roomLog: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
      ...overrides,
    };
    const profiles = {
      resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()),
    };
    const community = { getActiveHostIds: jest.fn().mockResolvedValue([]) };
    const service = new AgencyMemberService(prisma, community as never, profiles as never);
    return { service, prisma, profiles };
  }

  describe('getMember', () => {
    it("refuses a user who is not this agency's member", async () => {
      const { service, prisma } = build();
      prisma.agencyRelationship.findUnique.mockResolvedValue(null);

      await expect(service.getMember(AGENCY, MEMBER)).rejects.toBeInstanceOf(NotFoundException);
      // Nothing about the user is read once membership fails.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a member whose link is no longer active', async () => {
      // A released member must stop being visible: the exit policy hands users
      // back to the platform, and their data goes with them.
      const { service, prisma } = build();
      prisma.agencyRelationship.findUnique.mockResolvedValue({
        effectiveFrom: new Date(),
        status: 'ENDED',
      });

      await expect(service.getMember(AGENCY, MEMBER)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('scopes the membership lookup to the calling agency', async () => {
      const { service, prisma } = build();
      prisma.agencyRelationship.findUnique.mockResolvedValue(null);

      await expect(service.getMember(AGENCY, MEMBER)).rejects.toThrow();
      expect(prisma.agencyRelationship.findUnique).toHaveBeenCalledWith({
        where: { agencyId_hostId: { agencyId: AGENCY, hostId: MEMBER } },
        select: { effectiveFrom: true, status: true },
      });
    });

    it('returns the three tabs for a genuine member', async () => {
      const { service, prisma } = build();
      const joined = new Date('2026-05-10T00:00:00Z');
      prisma.agencyRelationship.findUnique.mockResolvedValue({
        effectiveFrom: joined,
        status: 'ACTIVE',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: MEMBER,
        username: 'ananya_21',
        fullName: 'Ananya',
        country: 'IN',
        createdAt: joined,
      });
      prisma.wallet.findUnique.mockResolvedValue({
        goldBalance: BigInt(7541),
        diamondBalance: BigInt(120),
      });
      prisma.giftTransaction.aggregate
        .mockResolvedValueOnce({ _count: 242, _sum: { totalCoinValue: BigInt(5000) } })
        .mockResolvedValueOnce({ _count: 866, _sum: { totalCoinValue: BigInt(9000) } });
      prisma.roomLog.count.mockResolvedValue(19);

      const res = await service.getMember(AGENCY, MEMBER);

      expect(res.profile).toMatchObject({
        username: 'ananya_21',
        country: 'IN',
        joinedAgencyAt: joined,
        coins: '7541',
      });
      expect(res.activity).toMatchObject({
        giftsSent: 242,
        giftsReceived: 866,
        roomsJoined: 19,
        // Gifts both ways plus room joins.
        totalActivities: 242 + 866 + 19,
      });
      expect(res.performance).toMatchObject({ coinsSent: '5000', coinsReceived: '9000' });
    });
  });

  describe('listMembers', () => {
    it('returns an empty page rather than querying users when the agency has none', async () => {
      const { service, prisma } = build();

      const res = await service.listMembers(AGENCY);

      expect(res).toMatchObject({ items: [], total: 0, totalPages: 0 });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('restricts the search to this agency’s member ids', async () => {
      const { service, prisma } = build();
      prisma.agencyRelationship.findMany.mockResolvedValue([
        { hostId: MEMBER, effectiveFrom: new Date('2026-05-10') },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: MEMBER, username: 'ananya_21', fullName: 'Ananya', country: 'IN' },
      ]);

      await service.listMembers(AGENCY, { search: 'ananya' });

      // The id filter is what stops a search matching a user in another agency.
      const where = prisma.user.findMany.mock.calls[0][0].where;
      expect(where.id).toEqual({ in: [MEMBER] });
      expect(where.OR).toBeDefined();
    });

    it('caps the page size so a caller cannot ask for the whole community at once', async () => {
      const { service, prisma } = build();
      prisma.agencyRelationship.findMany.mockResolvedValue(
        Array.from({ length: 250 }, (_, i) => ({
          hostId: `m-${i}`,
          effectiveFrom: new Date(2026, 0, 1 + i),
        })),
      );
      prisma.user.findMany.mockResolvedValue(
        Array.from({ length: 250 }, (_, i) => ({
          id: `m-${i}`,
          username: `u${i}`,
          fullName: null,
          country: 'IN',
        })),
      );

      const res = await service.listMembers(AGENCY, { limit: 5000 });

      expect(res.limit).toBe(100);
      expect(res.items).toHaveLength(100);
    });

    it('orders by join date, newest first', async () => {
      const { service, prisma } = build();
      prisma.agencyRelationship.findMany.mockResolvedValue([
        { hostId: 'older', effectiveFrom: new Date('2026-01-01') },
        { hostId: 'newer', effectiveFrom: new Date('2026-06-01') },
      ]);
      // Deliberately returned in the opposite order: `users` has no join date,
      // so the ordering cannot come from that query.
      prisma.user.findMany.mockResolvedValue([
        { id: 'older', username: 'older', fullName: null, country: 'IN' },
        { id: 'newer', username: 'newer', fullName: null, country: 'IN' },
      ]);

      const res = await service.listMembers(AGENCY);

      expect(res.items.map((m) => m.userId)).toEqual(['newer', 'older']);
    });
  });
});
