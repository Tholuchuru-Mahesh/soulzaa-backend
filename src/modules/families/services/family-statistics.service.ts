import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class FamilyStatisticsService {
  private readonly logger = new Logger(FamilyStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Updates daily, weekly, monthly, and lifetime aggregated statistics for a family.
   */
  async updateStatistics(
    familyId: string,
    expGained: bigint = BigInt(0),
    coins: bigint = BigInt(0),
  ) {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const periods = [
      { period: 'DAILY', dateKey },
      { period: 'MONTHLY', dateKey: monthKey },
      { period: 'LIFETIME', dateKey: 'ALL' },
    ];

    for (const p of periods) {
      await this.prisma.familyStatistics.upsert({
        where: {
          familyId_period_dateKey: {
            familyId,
            period: p.period,
            dateKey: p.dateKey,
          },
        },
        update: {
          expGained: { increment: expGained },
          coinsContributed: { increment: coins },
        },
        create: {
          familyId,
          period: p.period,
          dateKey: p.dateKey,
          expGained,
          coinsContributed: coins,
        },
      });
    }
  }

  /**
   * Retrieves aggregated statistics for a family across periods.
   */
  async getFamilyStatistics(familyId: string) {
    const stats = await this.prisma.familyStatistics.findMany({
      where: { familyId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return stats.map((s) => ({
      ...s,
      expGained: s.expGained.toString(),
      coinsContributed: s.coinsContributed.toString(),
    }));
  }
}
