import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import type {
  AgencyDashboardView,
  GrowthRange,
  GrowthSeries,
  TopPerformer,
} from '../interfaces/agency-dashboard.interface';
import { AgencyCommunityService } from './agency-community.service';
import { AgencyQueryService } from './agency-query.service';

const TOP_PERFORMER_WINDOW_DAYS = 30;
const TOP_PERFORMER_COUNT = 3;

/**
 * The agency owner's own dashboard — a composition layer over RBAC,
 * coin-seller inventory, community and settlement data. Owns no data of its
 * own.
 *
 * Distinct from `AgencySettlementController`, which answers the same domain for
 * platform staff: that surface takes an `agencyId` and is permission-gated,
 * this one is always the caller's own agency and can never be pointed at
 * someone else's.
 */
@Injectable()
export class AgencyDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly community: AgencyCommunityService,
    private readonly query: AgencyQueryService,
    private readonly roles: RoleResolver,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  async getDashboard(agencyId: string): Promise<AgencyDashboardView> {
    // One clock for the whole payload: sampling `new Date()` per query would
    // let the totals and the chart disagree about where "now" is.
    const now = new Date();

    const [identities, isCoinSeller, inventory, community, growth, topPerformers] =
      await Promise.all([
        this.profiles.resolvePublicIdentities([agencyId]),
        this.roles.hasRole(agencyId, 'COIN_SELLER'),
        this.prisma.coinSellerInventory.findUnique({
          where: { sellerId: agencyId },
          select: { availableBalance: true },
        }),
        this.community.getOverview(agencyId, now),
        this.community.getGrowth(agencyId, 'month', now),
        this.getTopPerformers(agencyId, now),
      ]);

    const me = identities.get(agencyId);

    return {
      agency: {
        displayName: me?.displayName ?? null,
        avatarUrl: me?.avatarUrl ?? null,
      },
      // The agency wallet is the coin inventory this agency bought from the
      // platform to resell — NOT the owner's personal wallet. Those are
      // separate pots: the personal one is the balance the home screen shows,
      // and surfacing it here made the dashboard claim coins the agency does
      // not hold. `0` (not null) because an agency with no inventory row
      // genuinely has nothing to sell.
      wallet: { coins: inventory?.availableBalance.toString() ?? '0' },
      coinSeller: {
        active: isCoinSeller,
        // Null, unlike the wallet above, so the card can tell "not a seller"
        // apart from "a seller who has sold out".
        availableBalance: inventory?.availableBalance.toString() ?? null,
      },
      community,

      // Null rather than 0. Nothing on the platform stores these yet, and a
      // zero would be a claim about this agency instead of about the platform.
      target: null,
      performance: null,
      operations: null,
      rewardInventory: null,
      assignedTasks: null,

      growth,
      topPerformers,
    };
  }

  /** Backs the chart's range dropdown without refetching the whole page. */
  getGrowth(agencyId: string, range: GrowthRange): Promise<GrowthSeries> {
    return this.community.getGrowth(agencyId, range, new Date());
  }

  private async getTopPerformers(agencyId: string, now: Date): Promise<TopPerformer[]> {
    const since = new Date(now.getTime() - TOP_PERFORMER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const ranked = await this.query.getTopHostsForAgency(agencyId, since, TOP_PERFORMER_COUNT);
    if (ranked.length === 0) return [];

    const identities = await this.profiles.resolvePublicIdentities(ranked.map((r) => r.hostId));

    return ranked.map((row) => {
      const identity = identities.get(row.hostId);
      return {
        rank: row.rank,
        userId: row.hostId,
        displayName: identity?.displayName ?? null,
        avatarUrl: identity?.avatarUrl ?? null,
        points: row.points,
      };
    });
  }
}
