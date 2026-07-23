import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class WithdrawalStatisticsService {
  private readonly logger = new Logger(WithdrawalStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Updates daily, monthly, and lifetime aggregated withdrawal statistics.
   */
  async updateStatistics(
    userId: string,
    amountCoins: bigint,
    type: 'REQUESTED' | 'COMPLETED' | 'REJECTED',
  ) {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const periods = [
      { period: 'DAILY', dateKey },
      { period: 'MONTHLY', dateKey: monthKey },
      { period: 'LIFETIME', dateKey: 'ALL' },
    ];

    const incrementField =
      type === 'REQUESTED'
        ? { totalRequestedCoins: { increment: amountCoins }, count: { increment: 1 } }
        : type === 'COMPLETED'
          ? { totalCompletedCoins: { increment: amountCoins } }
          : { totalRejectedCoins: { increment: amountCoins } };

    const createField = {
      totalRequestedCoins: type === 'REQUESTED' ? amountCoins : BigInt(0),
      totalCompletedCoins: type === 'COMPLETED' ? amountCoins : BigInt(0),
      totalRejectedCoins: type === 'REJECTED' ? amountCoins : BigInt(0),
      count: type === 'REQUESTED' ? 1 : 0,
    };

    for (const p of periods) {
      await this.prisma.withdrawalStatistics.upsert({
        where: {
          userId_period_dateKey: {
            userId,
            period: p.period,
            dateKey: p.dateKey,
          },
        },
        update: incrementField,
        create: {
          userId,
          period: p.period,
          dateKey: p.dateKey,
          ...createField,
        },
      });
    }
  }

  /**
   * Retrieves aggregated withdrawal statistics for a user.
   */
  async getUserStatistics(userId: string) {
    const stats = await this.prisma.withdrawalStatistics.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return stats.map((s) => ({
      ...s,
      totalRequestedCoins: s.totalRequestedCoins.toString(),
      totalCompletedCoins: s.totalCompletedCoins.toString(),
      totalRejectedCoins: s.totalRejectedCoins.toString(),
    }));
  }
}
