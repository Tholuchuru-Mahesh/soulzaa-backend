import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class RankingStatisticsService {
  private readonly logger = new Logger(RankingStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get todayKey() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  async incrementScoreAwarded(category: string, amount: bigint) {
    const dateKey = this.todayKey;
    await this.prisma.rankingStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { totalScoreAwarded: { increment: amount }, totalEntries: { increment: 0 } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        totalEntries: 0,
        totalScoreAwarded: amount,
        promotions: 0,
        demotions: 0,
      },
    });
  }

  async incrementPromotions(category: string) {
    const dateKey = this.todayKey;
    await this.prisma.rankingStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { promotions: { increment: 1 } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        totalEntries: 0,
        totalScoreAwarded: BigInt(0),
        promotions: 1,
        demotions: 0,
      },
    });
  }

  async incrementDemotions(category: string) {
    const dateKey = this.todayKey;
    await this.prisma.rankingStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { demotions: { increment: 1 } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        totalEntries: 0,
        totalScoreAwarded: BigInt(0),
        promotions: 0,
        demotions: 1,
      },
    });
  }

  async getPlatformSummary() {
    const [totalDefinitions, totalEntries, totalSnapshots, recentStats] = await Promise.all([
      this.prisma.rankingDefinition.count({ where: { status: 'ACTIVE' } }),
      this.prisma.rankingEntry.count(),
      this.prisma.enterpriseRankingSnapshot.count(),
      this.prisma.rankingStatistics.findMany({
        where: { period: 'DAILY' },
        orderBy: { dateKey: 'desc' },
        take: 30,
      }),
    ]);

    return { totalDefinitions, totalEntries, totalSnapshots, recentStats };
  }

  async getCategoryStatistics(category: string, limit = 30) {
    return this.prisma.rankingStatistics.findMany({
      where: { category },
      orderBy: { dateKey: 'desc' },
      take: limit,
    });
  }

  async getRankingTrends(rankingId: string, entityId: string, limit = 30) {
    return this.prisma.rankingHistory.findMany({
      where: { rankingId, entityId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getTopEntities(category: string, limit = 10) {
    const rankingDefs = await this.prisma.rankingDefinition.findMany({
      where: { category, status: 'ACTIVE' },
    });
    const ids = rankingDefs.map((d) => d.id);
    if (!ids.length) return [];

    return this.prisma.rankingEntry.findMany({
      where: { rankingId: { in: ids } },
      orderBy: { score: 'desc' },
      take: limit,
    });
  }
}
