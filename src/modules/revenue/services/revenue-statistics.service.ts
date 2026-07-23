import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class RevenueStatisticsService {
  private readonly logger = new Logger(RevenueStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Updates daily, weekly, monthly, and lifetime aggregated statistics for a host and room.
   */
  async updateStatistics(hostId: string, roomId: string, earnedAmount: bigint) {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const weekKey = `${now.getFullYear()}-W${Math.ceil(now.getDate() / 7)}`;
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const periods = [
      { period: 'DAILY', dateKey },
      { period: 'WEEKLY', dateKey: weekKey },
      { period: 'MONTHLY', dateKey: monthKey },
      { period: 'LIFETIME', dateKey: 'ALL' },
    ];

    for (const p of periods) {
      await this.prisma.revenueStatistics.upsert({
        where: {
          hostId_period_dateKey: {
            hostId,
            period: p.period,
            dateKey: p.dateKey,
          },
        },
        update: {
          totalCoins: { increment: earnedAmount },
          giftCount: { increment: 1 },
        },
        create: {
          hostId,
          roomId,
          period: p.period,
          dateKey: p.dateKey,
          totalCoins: earnedAmount,
          giftCount: 1,
        },
      });
    }
  }

  /**
   * Retrieves aggregated statistics for a host across periods.
   */
  async getHostStatistics(hostId: string) {
    const stats = await this.prisma.revenueStatistics.findMany({
      where: { hostId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return stats.map((s) => ({
      ...s,
      totalCoins: s.totalCoins.toString(),
    }));
  }
}
