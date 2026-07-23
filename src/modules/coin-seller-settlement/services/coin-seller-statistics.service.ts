import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class CoinSellerStatisticsService {
  private readonly logger = new Logger(CoinSellerStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Updates daily, weekly, monthly, and lifetime aggregated statistics for a coin seller.
   */
  async updateStatistics(sellerId: string, commissionCoins: bigint) {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const weekKey = `${now.getFullYear()}-W${Math.ceil(now.getDate() / 7)}`;
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const periods = [
      { period: 'DAILY', dateKey },
      { period: 'WEEKLY', dateKey: weekKey },
      { period: 'MONTHLY', dateKey: monthKey },
      { period: 'LIFETIME', dateKey: 'ALL' },
    ];

    for (const p of periods) {
      await this.prisma.coinSellerStatistics.upsert({
        where: {
          sellerId_period_dateKey: {
            sellerId,
            period: p.period,
            dateKey: p.dateKey,
          },
        },
        update: {
          totalCommissionCoins: { increment: commissionCoins },
          settlementCount: { increment: 1 },
        },
        create: {
          sellerId,
          period: p.period,
          dateKey: p.dateKey,
          totalCommissionCoins: commissionCoins,
          settlementCount: 1,
        },
      });
    }
  }

  /**
   * Retrieves aggregated statistics for a coin seller across periods.
   */
  async getSellerStatistics(sellerId: string) {
    const stats = await this.prisma.coinSellerStatistics.findMany({
      where: { sellerId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return stats.map((s) => ({
      ...s,
      totalCommissionCoins: s.totalCommissionCoins.toString(),
    }));
  }
}
