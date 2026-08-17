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
      roomMember: { count: jest.fn().mockResolvedValue(0) },
      videoRoomMember: { count: jest.fn().mockResolvedValue(0) },
      badgeInventory: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      userStatistics: { findMany: jest.fn().mockResolvedValue([]) },
      ...overrides,
    };
    const profiles = {
      resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()),
    };
    const community = { getActiveHostIds: jest.fn().mockResolvedValue([]) };
    const scores = { rankAgency: jest.fn().mockResolvedValue(new Map()) };
    const service = new AgencyMemberService(
      prisma,
      community as never,
      profiles as never,
      scores as never,
    );
    return { service, prisma, profiles, scores };
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

    it('returns the overview blocks for a genuine member', async () => {
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
      // Sent-now, sent-before, received-now, received-before.
      prisma.giftTransaction.aggregate
        .mockResolvedValueOnce({ _count: 242, _sum: { totalCoinValue: BigInt(5000) } })
        .mockResolvedValueOnce({ _count: 121, _sum: { totalCoinValue: BigInt(2500) } })
        .mockResolvedValueOnce({ _count: 866, _sum: { totalCoinValue: BigInt(9000) } })
        .mockResolvedValueOnce({ _count: 866, _sum: { totalCoinValue: BigInt(9000) } });

      const res: any = await service.getMember(AGENCY, MEMBER);

      expect(res.profile).toMatchObject({
        username: 'ananya_21',
        country: 'IN',
        joinedAgencyAt: joined,
        coins: '7541',
      });
      expect(res.stats.giftsSent).toEqual({
        value: 242,
        changePercent: 100,
        comparedTo: 'LAST_MONTH',
      });
      // Identical windows are a flat 0%, which is a real measurement — unlike
      // a null, which means the baseline could not be measured at all.
      expect(res.stats.giftsReceived.changePercent).toBe(0);
      expect(res.stats.coinsSent.value).toBe('5000');
    });
  });

  describe('getMember profile fields', () => {
    function activeMember(prisma: any, user: Record<string, unknown> = {}) {
      prisma.agencyRelationship.findUnique.mockResolvedValue({
        effectiveFrom: new Date('2026-05-10T00:00:00Z'),
        status: 'ACTIVE',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: MEMBER,
        username: 'balayya',
        fullName: 'Balayya Naidu',
        email: 'balayya@example.com',
        gender: 'MALE',
        preferredLanguage: 'Telugu',
        country: 'IN',
        createdAt: new Date('2026-04-02T00:00:00Z'),
        ...user,
      });
    }

    const RANKED = new Map([
      [
        MEMBER,
        {
          userId: MEMBER,
          score: 72,
          rank: 7,
          totalMembers: 7541,
          topPercent: 1,
          grade: { min: 60, code: 'GOOD', label: 'Good', caption: 'nearly there' },
          inputs: { loginDays: 12, roomsJoined: 18, giftsSent: 50, giftsReceived: 50 },
        },
      ],
    ]);

    it("returns the member's own email, name and username", async () => {
      // The screen showed one hard-coded address for every member; these three
      // fields are the whole point of the change.
      const { service, prisma } = build();
      activeMember(prisma);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.profile.email).toBe('balayya@example.com');
      expect(result.profile.fullName).toBe('Balayya Naidu');
      expect(result.profile.username).toBe('balayya');
    });

    it('reports an unset gender and language as null rather than guessing', async () => {
      const { service, prisma } = build();
      activeMember(prisma, { gender: null, preferredLanguage: null });

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.profile.gender).toBeNull();
      expect(result.profile.language).toBeNull();
    });

    it('returns no badge rather than an empty one when nothing is equipped', async () => {
      const { service, prisma } = build();
      activeMember(prisma);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.badge).toBeNull();
    });

    it("carries the member's equipped badge with the agency percentile", async () => {
      const { service, prisma, scores } = build();
      activeMember(prisma);
      prisma.badgeInventory.findFirst.mockResolvedValue({
        badgeCode: 'AGENCY_STAR',
        badge: { name: 'Agency star', iconUrl: 'https://cdn/star.png', tier: 'GOLD' },
      });
      prisma.badgeInventory.count.mockResolvedValue(7);
      scores.rankAgency.mockResolvedValue(RANKED);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.badge).toEqual({
        code: 'AGENCY_STAR',
        name: 'Agency star',
        iconUrl: 'https://cdn/star.png',
        tier: 'GOLD',
        topPercent: 1,
        totalBadges: 7,
      });
    });

    it('carries rank, score and grade from the ranking service', async () => {
      const { service, prisma, scores } = build();
      activeMember(prisma);
      scores.rankAgency.mockResolvedValue(RANKED);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.summary).toEqual({
        rank: 7,
        totalMembers: 7541,
        engagementScore: 72,
        grade: { code: 'GOOD', label: 'Good', caption: 'nearly there' },
      });
    });

    it('reports a null summary rather than "#0 of 0" for an unranked member', async () => {
      const { service, prisma } = build();
      activeMember(prisma);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.summary).toEqual({
        rank: null,
        totalMembers: null,
        engagementScore: null,
        grade: null,
      });
    });

    it('reports a null trend when the baseline window was empty', async () => {
      // Growth from nothing is not a percentage; both "∞%" and "100%" lie.
      const { service, prisma } = build();
      activeMember(prisma);

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.stats.giftsSent.changePercent).toBeNull();
      expect(result.stats.giftsSent.comparedTo).toBe('LAST_MONTH');
    });

    it('keeps coin figures as strings', async () => {
      const { service, prisma } = build();
      activeMember(prisma);
      prisma.wallet.findUnique.mockResolvedValue({
        goldBalance: BigInt('9007199254740993'),
        diamondBalance: BigInt(0),
      });

      const result: any = await service.getMember(AGENCY, MEMBER);

      expect(result.profile.coins).toBe('9007199254740993');
      expect(typeof result.stats.coinsSent.value).toBe('string');
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

    function threeMembers(prisma: any) {
      prisma.agencyRelationship.findMany.mockResolvedValue([
        { hostId: 'a', effectiveFrom: new Date('2026-01-03') },
        { hostId: 'b', effectiveFrom: new Date('2026-01-02') },
        { hostId: 'c', effectiveFrom: new Date('2026-01-01') },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'a', username: 'a', fullName: null, country: 'IN' },
        { id: 'b', username: 'b', fullName: null, country: 'IN' },
        { id: 'c', username: 'c', fullName: null, country: 'IN' },
      ]);
    }

    it('returns the real level from statistics', async () => {
      const { service, prisma } = build();
      threeMembers(prisma);
      prisma.userStatistics.findMany.mockResolvedValue([{ userId: 'a', level: 18 }]);

      const res: any = await service.listMembers(AGENCY);

      expect(res.items.find((m: any) => m.userId === 'a').level).toBe(18);
    });

    it('reports level 1 for a member with no statistics row', async () => {
      // Every account starts at level 1, so 1 is the true answer — not 0.
      const { service, prisma } = build();
      threeMembers(prisma);

      const res: any = await service.listMembers(AGENCY);

      expect(res.items[0].level).toBe(1);
    });

    it('filters to the top decile using the agency ranking', async () => {
      const { service, prisma, scores } = build();
      threeMembers(prisma);
      scores.rankAgency.mockResolvedValue(
        new Map<string, unknown>([
          ['a', { userId: 'a', rank: 1, totalMembers: 30, topPercent: 4, score: 90 }],
          ['b', { userId: 'b', rank: 2, totalMembers: 30, topPercent: 7, score: 80 }],
          ['c', { userId: 'c', rank: 25, totalMembers: 30, topPercent: 84, score: 10 }],
        ]),
      );

      const res: any = await service.listMembers(AGENCY, { filter: 'top' });

      expect(res.items.map((m: any) => m.userId).sort()).toEqual(['a', 'b']);
      expect(res.total).toBe(2);
    });

    it('falls back to the single best member when the agency is too small for a percentile', async () => {
      // topPercent is null below 10 members, so "top 10%" would match nobody.
      const { service, prisma, scores } = build();
      threeMembers(prisma);
      scores.rankAgency.mockResolvedValue(
        new Map<string, unknown>([
          ['a', { userId: 'a', rank: 2, totalMembers: 3, topPercent: null, score: 40 }],
          ['b', { userId: 'b', rank: 1, totalMembers: 3, topPercent: null, score: 70 }],
          ['c', { userId: 'c', rank: 3, totalMembers: 3, topPercent: null, score: 10 }],
        ]),
      );

      const res: any = await service.listMembers(AGENCY, { filter: 'top' });

      expect(res.items.map((m: any) => m.userId)).toEqual(['b']);
    });

    it('filters before paginating, so page 2 is the second page of matches', async () => {
      const { service, prisma, scores } = build();
      prisma.agencyRelationship.findMany.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          hostId: `m${i}`,
          effectiveFrom: new Date(2026, 0, 1 + i),
        })),
      );
      prisma.user.findMany.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          id: `m${i}`,
          username: `m${i}`,
          fullName: null,
          country: 'IN',
        })),
      );
      // Only the first four are inside the top decile.
      scores.rankAgency.mockResolvedValue(
        new Map<string, unknown>(
          Array.from({ length: 30 }, (_, i) => [
            `m${i}`,
            {
              userId: `m${i}`,
              rank: i + 1,
              totalMembers: 30,
              topPercent: i < 4 ? 5 : 50,
              score: 0,
            },
          ]),
        ),
      );

      const res: any = await service.listMembers(AGENCY, { filter: 'top', page: 2, limit: 3 });

      expect(res.total).toBe(4);
      expect(res.totalPages).toBe(2);
      expect(res.items).toHaveLength(1);
    });

    it('filters to recently active members', async () => {
      const { service, prisma } = build();
      threeMembers(prisma);
      prisma.userSession.findMany.mockResolvedValue([{ userId: 'b' }]);

      const res: any = await service.listMembers(AGENCY, { filter: 'active' });

      expect(res.items.map((m: any) => m.userId)).toEqual(['b']);
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
