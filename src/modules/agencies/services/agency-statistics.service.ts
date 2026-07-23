import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class AgencyStatisticsService {
  private readonly logger = new Logger(AgencyStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Updates daily, weekly, monthly, and lifetime aggregated statistics for an agency.
   */
  async updateStatistics(agencyId: string, commissionCoins: bigint) {
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
      await this.prisma.agencyStatistics.upsert({
        where: {
          agencyId_period_dateKey: {
            agencyId,
            period: p.period,
            dateKey: p.dateKey,
          },
        },
        update: {
          totalCommissionCoins: { increment: commissionCoins },
          settlementCount: { increment: 1 },
        },
        create: {
          agencyId,
          period: p.period,
          dateKey: p.dateKey,
          totalCommissionCoins: commissionCoins,
          settlementCount: 1,
        },
      });
    }
  }

  /**
   * Retrieves aggregated statistics for an agency across periods.
   */
  async getAgencyStatistics(agencyId: string) {
    const stats = await this.prisma.agencyStatistics.findMany({
      where: { agencyId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return stats.map((s) => ({
      ...s,
      totalCommissionCoins: s.totalCommissionCoins.toString(),
    }));
  }
}
