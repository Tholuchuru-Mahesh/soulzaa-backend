import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class VipStatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Updates pre-aggregated VIP statistics.
   */
  async updateStatistics(
    action: 'PURCHASE' | 'RENEW' | 'UPGRADE' | 'EXPIRE',
    revenue: bigint = BigInt(0),
  ) {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const periods = [
      { period: 'DAILY', dateKey },
      { period: 'MONTHLY', dateKey: monthKey },
      { period: 'LIFETIME', dateKey: 'ALL' },
    ];

    const isPurchase = action === 'PURCHASE';
    const isRenew = action === 'RENEW';
    const isUpgrade = action === 'UPGRADE';
    const isExpire = action === 'EXPIRE';

    for (const p of periods) {
      await this.prisma.vipStatistics.upsert({
        where: {
          period_dateKey: {
            period: p.period,
            dateKey: p.dateKey,
          },
        },
        update: {
          purchasesCount: isPurchase ? { increment: 1 } : undefined,
          renewalsCount: isRenew ? { increment: 1 } : undefined,
          upgradesCount: isUpgrade ? { increment: 1 } : undefined,
          expiredCount: isExpire ? { increment: 1 } : undefined,
          totalRevenue: { increment: revenue },
        },
        create: {
          period: p.period,
          dateKey: p.dateKey,
          purchasesCount: isPurchase ? 1 : 0,
          renewalsCount: isRenew ? 1 : 0,
          upgradesCount: isUpgrade ? 1 : 0,
          expiredCount: isExpire ? 1 : 0,
          totalRevenue: revenue,
        },
      });
    }
  }

  /**
   * Retrieves aggregated statistics.
   */
  async getStatistics() {
    const stats = await this.prisma.vipStatistics.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    const activeVipCount = await this.prisma.vipMembership.count({
      where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
    });

    return stats.map((s) => ({
      ...s,
      activeVipCount,
      totalRevenue: s.totalRevenue.toString(),
    }));
  }
}
