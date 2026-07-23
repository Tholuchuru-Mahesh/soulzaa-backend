import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class CoinSellerQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves global coin seller settlement summary metrics.
   */
  async getGlobalSummary() {
    const [totalSettlements, agg] = await Promise.all([
      this.prisma.coinSellerSettlement.count(),
      this.prisma.coinSellerSettlement.aggregate({
        _sum: {
          purchaseAmountCoins: true,
          sellerCommissionCoins: true,
        },
      }),
    ]);

    return {
      totalSettlements,
      totalPurchaseCoinsProcessed: (agg._sum.purchaseAmountCoins ?? BigInt(0)).toString(),
      totalSellerCommissionPaid: (agg._sum.sellerCommissionCoins ?? BigInt(0)).toString(),
    };
  }

  /**
   * Retrieves top seller leaderboards by commission earnings.
   */
  async getTopSellers(limit = 10) {
    const top = await this.prisma.coinSellerStatistics.findMany({
      where: { period: 'LIFETIME' },
      orderBy: { totalCommissionCoins: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });

    return top.map((t) => ({
      sellerId: t.sellerId,
      totalCommissionCoins: t.totalCommissionCoins.toString(),
      settlementCount: t.settlementCount,
      updatedAt: t.updatedAt,
    }));
  }
}
