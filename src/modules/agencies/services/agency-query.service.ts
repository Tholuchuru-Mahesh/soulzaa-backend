import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class AgencyQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves global agency settlement summary metrics.
   */
  async getGlobalSummary() {
    const [totalSettlements, agg] = await Promise.all([
      this.prisma.agencySettlement.count(),
      this.prisma.agencySettlement.aggregate({
        _sum: {
          hostEarningsCoins: true,
          agencyCommissionCoins: true,
        },
      }),
    ]);

    return {
      totalSettlements,
      totalHostEarningsProcessed: (agg._sum.hostEarningsCoins ?? BigInt(0)).toString(),
      totalAgencyCommissionPaid: (agg._sum.agencyCommissionCoins ?? BigInt(0)).toString(),
    };
  }

  /**
   * One agency's highest-earning hosts since `since`.
   *
   * Ranked by the host earnings that produced the commission rather than by the
   * commission itself: the two orderings only differ if the rate changed
   * mid-window, and a leaderboard shown to hosts should rank what they earned.
   */
  async getTopHostsForAgency(agencyId: string, since: Date, limit = 3) {
    const grouped = await this.prisma.agencySettlement.groupBy({
      by: ['hostId'],
      where: { agencyId, createdAt: { gte: since } },
      _sum: { hostEarningsCoins: true },
      orderBy: { _sum: { hostEarningsCoins: 'desc' } },
      take: Math.min(50, Math.max(1, limit)),
    });

    return grouped.map((row, index) => ({
      rank: index + 1,
      hostId: row.hostId,
      points: (row._sum.hostEarningsCoins ?? BigInt(0)).toString(),
    }));
  }

  /**
   * Retrieves top agency leaderboards by commission earnings.
   */
  async getTopAgencies(limit = 10) {
    const top = await this.prisma.agencyStatistics.findMany({
      where: { period: 'LIFETIME' },
      orderBy: { totalCommissionCoins: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });

    return top.map((t) => ({
      agencyId: t.agencyId,
      totalCommissionCoins: t.totalCommissionCoins.toString(),
      settlementCount: t.settlementCount,
      updatedAt: t.updatedAt,
    }));
  }
}
