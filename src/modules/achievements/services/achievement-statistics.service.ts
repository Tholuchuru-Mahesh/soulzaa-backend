import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class AchievementStatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  private get todayKey() {
    return new Date().toISOString().split('T')[0];
  }

  async incrementUnlocks(count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.achievementStatistics.upsert({
      where: { period_dateKey: { period: 'DAILY', dateKey } },
      update: { totalUnlocks: { increment: count }, uniqueUsersUnlocked: { increment: 1 } },
      create: {
        period: 'DAILY',
        dateKey,
        totalUnlocks: count,
        uniqueUsersUnlocked: 1,
        totalBadgesAwarded: 0,
        totalRewardsClaimed: 0,
      },
    });
  }

  async incrementBadgesAwarded(count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.achievementStatistics.upsert({
      where: { period_dateKey: { period: 'DAILY', dateKey } },
      update: { totalBadgesAwarded: { increment: count } },
      create: {
        period: 'DAILY',
        dateKey,
        totalUnlocks: 0,
        uniqueUsersUnlocked: 0,
        totalBadgesAwarded: count,
        totalRewardsClaimed: 0,
      },
    });
  }

  async incrementRewardsClaimed(count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.achievementStatistics.upsert({
      where: { period_dateKey: { period: 'DAILY', dateKey } },
      update: { totalRewardsClaimed: { increment: count } },
      create: {
        period: 'DAILY',
        dateKey,
        totalUnlocks: 0,
        uniqueUsersUnlocked: 0,
        totalBadgesAwarded: 0,
        totalRewardsClaimed: count,
      },
    });
  }

  async getPlatformSummary() {
    const [totalDefinitions, totalUnlocks, totalBadgesInInventory, rareBadges, recentDaily] =
      await Promise.all([
        this.prisma.achievementDefinition.count({ where: { status: 'ACTIVE' } }),
        this.prisma.userAchievement.count(),
        this.prisma.badgeInventory.count(),
        this.prisma.badgeDefinition.count({ where: { rarity: { in: ['EPIC', 'LEGENDARY'] } } }),
        this.prisma.achievementStatistics.findMany({
          where: { period: 'DAILY' },
          orderBy: { dateKey: 'desc' },
          take: 30,
        }),
      ]);

    const mostEarnedAchievements = await this.prisma.userAchievement.groupBy({
      by: ['achievementId'],
      _count: { achievementId: true },
      orderBy: { _count: { achievementId: 'desc' } },
      take: 10,
    });

    return {
      totalDefinitions,
      totalUnlocks,
      totalBadgesInInventory,
      rareBadges,
      recentDaily,
      mostEarnedAchievements,
    };
  }

  async getProgressDistribution() {
    const buckets = await this.prisma.achievementProgress.groupBy({
      by: ['achievementId'],
      _avg: { percentComplete: true },
      _count: { id: true },
    });
    return buckets;
  }
}
