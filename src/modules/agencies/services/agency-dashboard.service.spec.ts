import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { PROFILE_SERVICE } from 'src/modules/users/interfaces/profile.interface';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { AgencyCommunityService } from './agency-community.service';
import { AgencyDashboardService } from './agency-dashboard.service';
import { AgencyQueryService } from './agency-query.service';

const AGENCY_ID = '11111111-1111-4111-8111-111111111111';
const HOST_A = '22222222-2222-4222-8222-222222222222';
const HOST_B = '33333333-3333-4333-8333-333333333333';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Agency dashboard', () => {
  let community: AgencyCommunityService;
  let query: AgencyQueryService;
  let dashboard: AgencyDashboardService;

  const prisma: any = {
    agencyRelationship: { findMany: jest.fn(), count: jest.fn() },
    agencySettlement: { groupBy: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
    agencyStatistics: { findMany: jest.fn() },
    userSession: { findMany: jest.fn() },
    coinSellerInventory: { findUnique: jest.fn() },
  };

  const wallet = { getBalance: jest.fn() };
  const profiles = { resolvePublicIdentities: jest.fn() };
  const roles = { hasRole: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgencyCommunityService,
        AgencyQueryService,
        AgencyDashboardService,
        { provide: PrismaService, useValue: prisma },
        { provide: RoleResolver, useValue: roles },
        { provide: WALLET_SERVICE, useValue: wallet },
        { provide: PROFILE_SERVICE, useValue: profiles },
      ],
    }).compile();

    community = module.get(AgencyCommunityService);
    query = module.get(AgencyQueryService);
    dashboard = module.get(AgencyDashboardService);
  });

  describe('AgencyCommunityService.getOverview', () => {
    it('reports a percentage change against the same window one period back', async () => {
      prisma.agencyRelationship.findMany.mockResolvedValue([
        { hostId: HOST_A },
        { hostId: HOST_B },
      ]);
      // now, then (month ago)
      prisma.agencyRelationship.count.mockResolvedValueOnce(110).mockResolvedValueOnce(100);
      // daily now, daily then, monthly now, monthly then
      prisma.userSession.findMany
        .mockResolvedValueOnce([{ userId: HOST_A }, { userId: HOST_B }])
        .mockResolvedValueOnce([{ userId: HOST_A }])
        .mockResolvedValueOnce([{ userId: HOST_A }, { userId: HOST_B }])
        .mockResolvedValueOnce([{ userId: HOST_A }, { userId: HOST_B }]);

      const overview = await community.getOverview(AGENCY_ID, new Date('2026-08-13T00:00:00Z'));

      expect(overview.totalUsers).toEqual({
        value: 110,
        changePercent: 10,
        comparedTo: 'LAST_MONTH',
      });
      expect(overview.dailyActive.value).toBe(2);
      expect(overview.dailyActive.changePercent).toBe(100);
      expect(overview.monthlyActive.changePercent).toBe(0);
    });

    it('returns a null change rather than a fabricated percentage from a zero baseline', async () => {
      prisma.agencyRelationship.findMany.mockResolvedValue([]);
      prisma.agencyRelationship.count.mockResolvedValueOnce(5).mockResolvedValueOnce(0);
      prisma.userSession.findMany.mockResolvedValue([]);

      const overview = await community.getOverview(AGENCY_ID, new Date('2026-08-13T00:00:00Z'));

      expect(overview.totalUsers.value).toBe(5);
      expect(overview.totalUsers.changePercent).toBeNull();
    });

    it('counts no active hosts, and issues no session query, for an agency with no members', async () => {
      prisma.agencyRelationship.findMany.mockResolvedValue([]);
      prisma.agencyRelationship.count.mockResolvedValue(0);

      const overview = await community.getOverview(AGENCY_ID, new Date('2026-08-13T00:00:00Z'));

      expect(overview.dailyActive.value).toBe(0);
      expect(prisma.userSession.findMany).not.toHaveBeenCalled();
    });

    it('restricts the activity query to the agency’s own hosts', async () => {
      prisma.agencyRelationship.findMany.mockResolvedValue([{ hostId: HOST_A }]);
      prisma.agencyRelationship.count.mockResolvedValue(1);
      prisma.userSession.findMany.mockResolvedValue([{ userId: HOST_A }]);

      await community.getOverview(AGENCY_ID, new Date('2026-08-13T00:00:00Z'));

      for (const call of prisma.userSession.findMany.mock.calls) {
        expect(call[0].where.userId).toEqual({ in: [HOST_A] });
      }
    });
  });

  describe('AgencyCommunityService.getGrowth', () => {
    it('plots one point per day and counts a member only while their window is open', async () => {
      const now = new Date('2026-08-13T00:00:00Z');
      prisma.agencyRelationship.findMany.mockResolvedValue([
        // Joined before the window, still a member.
        { effectiveFrom: new Date(now.getTime() - 30 * DAY_MS), effectiveUntil: null },
        // Left three days ago.
        {
          effectiveFrom: new Date(now.getTime() - 30 * DAY_MS),
          effectiveUntil: new Date(now.getTime() - 3 * DAY_MS),
        },
      ]);

      const series = await community.getGrowth(AGENCY_ID, 'week', now);

      expect(series.range).toBe('week');
      expect(series.points).toHaveLength(7);
      expect(series.points[0].value).toBe(2);
      expect(series.points[6].value).toBe(1);
      expect(series.points[0].date).toBe('2026-08-07');
      expect(series.points[6].date).toBe('2026-08-13');
    });

    it('plots 30 points for a month and 90 for a quarter', async () => {
      prisma.agencyRelationship.findMany.mockResolvedValue([]);
      const now = new Date('2026-08-13T00:00:00Z');

      expect((await community.getGrowth(AGENCY_ID, 'month', now)).points).toHaveLength(30);
      expect((await community.getGrowth(AGENCY_ID, 'quarter', now)).points).toHaveLength(90);
    });
  });

  describe('AgencyQueryService.getTopHostsForAgency', () => {
    it('ranks hosts by summed earnings and serialises BigInt coins as strings', async () => {
      prisma.agencySettlement.groupBy.mockResolvedValue([
        { hostId: HOST_A, _sum: { hostEarningsCoins: BigInt('10221') } },
        { hostId: HOST_B, _sum: { hostEarningsCoins: BigInt('9861') } },
      ]);

      const top = await query.getTopHostsForAgency(AGENCY_ID, new Date('2026-07-14T00:00:00Z'), 3);

      expect(top).toEqual([
        { rank: 1, hostId: HOST_A, points: '10221' },
        { rank: 2, hostId: HOST_B, points: '9861' },
      ]);
      expect(prisma.agencySettlement.groupBy.mock.calls[0][0].where.agencyId).toBe(AGENCY_ID);
    });
  });

  describe('AgencyDashboardService.getDashboard', () => {
    beforeEach(() => {
      prisma.agencyRelationship.findMany.mockResolvedValue([]);
      prisma.agencyRelationship.count.mockResolvedValue(0);
      prisma.userSession.findMany.mockResolvedValue([]);
      prisma.agencySettlement.groupBy.mockResolvedValue([]);
      prisma.coinSellerInventory.findUnique.mockResolvedValue(null);
      wallet.getBalance.mockResolvedValue({ gold: 900, diamond: 15222, game: 7 });
      roles.hasRole.mockResolvedValue(false);
      profiles.resolvePublicIdentities.mockResolvedValue(
        new Map([[AGENCY_ID, { displayName: 'Soulzaa Agency', avatarUrl: 'https://cdn/a.png' }]]),
      );
    });

<<<<<<< Updated upstream
    it('reads the coin seller inventory balance for agency wallet', async () => {
      const view = await dashboard.getDashboard(AGENCY_ID);

      expect(view.wallet.coins).toBe('0');
      expect(wallet.getBalance).toHaveBeenCalledWith(AGENCY_ID);
=======
    it('reports the coins bought for the agency as the wallet balance', async () => {
      prisma.coinSellerInventory.findUnique.mockResolvedValue({
        availableBalance: BigInt('20145'),
      });

      const view = await dashboard.getDashboard(AGENCY_ID);

      // The 15222 diamond figure above is the owner's *personal* earnings
      // wallet — what the home screen shows. The agency wallet is a different
      // pot entirely: coin inventory bought from the platform to resell.
      expect(view.wallet.coins).toBe('20145');
      expect(view.wallet.coins).toBe(view.coinSeller.availableBalance);
    });

    it('reports a zero agency wallet when the agency holds no inventory row', async () => {
      const view = await dashboard.getDashboard(AGENCY_ID);

      expect(view.wallet.coins).toBe('0');
>>>>>>> Stashed changes
    });

    it('returns null — never zero — for metrics the platform cannot answer yet', async () => {
      const view = await dashboard.getDashboard(AGENCY_ID);

      expect(view.target).toBeNull();
      expect(view.performance).toBeNull();
      expect(view.operations).toBeNull();
      expect(view.rewardInventory).toBeNull();
      expect(view.assignedTasks).toBeNull();
    });

    it('resolves coin-seller status from RBAC and leaves the balance null without inventory', async () => {
      roles.hasRole.mockResolvedValue(true);

      const view = await dashboard.getDashboard(AGENCY_ID);

      expect(roles.hasRole).toHaveBeenCalledWith(AGENCY_ID, 'COIN_SELLER');
      expect(view.coinSeller).toEqual({ active: true, availableBalance: null });
    });

    it('serialises the coin-seller inventory balance as a string when present', async () => {
      prisma.coinSellerInventory.findUnique.mockResolvedValue({
        availableBalance: BigInt('4300'),
      });

      const view = await dashboard.getDashboard(AGENCY_ID);

      expect(view.coinSeller.availableBalance).toBe('4300');
      expect(view.wallet.coins).toBe('4300');
    });

    it('renders a brand-new agency as real zeros with an empty leaderboard', async () => {
      const view = await dashboard.getDashboard(AGENCY_ID);

      expect(view.community.totalUsers.value).toBe(0);
      expect(view.community.totalUsers.changePercent).toBeNull();
      expect(view.topPerformers).toEqual([]);
      expect(view.growth.points).toHaveLength(30);
    });

    it('joins top performers to their profile identity', async () => {
      prisma.agencySettlement.groupBy.mockResolvedValue([
        { hostId: HOST_A, _sum: { hostEarningsCoins: BigInt('10221') } },
      ]);
      profiles.resolvePublicIdentities
        .mockResolvedValueOnce(
          new Map([[AGENCY_ID, { displayName: 'Soulzaa Agency', avatarUrl: null }]]),
        )
        .mockResolvedValueOnce(
          new Map([[HOST_A, { displayName: 'Ramya', avatarUrl: 'https://cdn/r.png' }]]),
        );

      const view = await dashboard.getDashboard(AGENCY_ID);

      expect(view.topPerformers).toEqual([
        {
          rank: 1,
          userId: HOST_A,
          displayName: 'Ramya',
          avatarUrl: 'https://cdn/r.png',
          points: '10221',
        },
      ]);
    });

    it('keeps a performer whose profile could not be resolved, with null identity', async () => {
      prisma.agencySettlement.groupBy.mockResolvedValue([
        { hostId: HOST_A, _sum: { hostEarningsCoins: BigInt('10221') } },
      ]);
      profiles.resolvePublicIdentities.mockResolvedValue(new Map());

      const view = await dashboard.getDashboard(AGENCY_ID);

      expect(view.topPerformers[0].displayName).toBeNull();
      expect(view.topPerformers[0].points).toBe('10221');
      expect(view.agency.displayName).toBeNull();
    });
  });
});
