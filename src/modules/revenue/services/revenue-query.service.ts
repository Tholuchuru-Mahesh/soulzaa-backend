import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class RevenueQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves global revenue summary.
   */
  async getGlobalSummary() {
    const [totalDistributions, agg] = await Promise.all([
      this.prisma.revenueDistribution.count(),
      this.prisma.revenueDistribution.aggregate({
        _sum: {
          totalCoinValue: true,
          hostEarningsCoins: true,
          platformEarningsCoins: true,
        },
      }),
    ]);

    return {
      totalDistributions,
      totalVolume: (agg._sum.totalCoinValue ?? BigInt(0)).toString(),
      totalHostEarnings: (agg._sum.hostEarningsCoins ?? BigInt(0)).toString(),
      totalPlatformEarnings: (agg._sum.platformEarningsCoins ?? BigInt(0)).toString(),
    };
  }

  /**
   * Retrieves top earning hosts leaderboard.
   */
  async getTopHosts(limit = 10) {
    const top = await this.prisma.hostEarnings.findMany({
      orderBy: { totalEarnedCoins: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });

    return top.map((t) => ({
      hostId: t.hostId,
      totalEarnedCoins: t.totalEarnedCoins.toString(),
      totalGiftCount: t.totalGiftCount,
      updatedAt: t.updatedAt,
    }));
  }
}
