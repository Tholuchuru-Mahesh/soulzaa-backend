import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class AchievementQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns users with the most achievement unlocks.
   */
  async getTopAchievers(limit = 50) {
    return this.prisma.userAchievement.groupBy({
      by: ['userId'],
      _count: { achievementId: true },
      orderBy: { _count: { achievementId: 'desc' } },
      take: limit,
    });
  }

  /**
   * Returns achievements sorted by unlock frequency (most popular).
   */
  async getMostEarnedAchievements(limit = 20) {
    return this.prisma.userAchievement.groupBy({
      by: ['achievementId'],
      _count: { userId: true },
      orderBy: { _count: { userId: 'desc' } },
      take: limit,
    });
  }

  /**
   * Returns the rarest achievements (fewest users completed).
   */
  async getRarestAchievements(limit = 20) {
    return this.prisma.userAchievement.groupBy({
      by: ['achievementId'],
      _count: { userId: true },
      orderBy: { _count: { userId: 'asc' } },
      take: limit,
      having: { userId: { _count: { gt: 0 } } },
    });
  }

  /**
   * Completion rate per achievement (unlocked / total users with progress).
   */
  async getCompletionRates(limit = 20) {
    const [definitions, progressCounts, unlockCounts] = await Promise.all([
      this.prisma.achievementDefinition.findMany({
        where: { status: 'ACTIVE' },
        take: limit,
        orderBy: { displayOrder: 'asc' },
      }),
      this.prisma.achievementProgress.groupBy({
        by: ['achievementId'],
        _count: { userId: true },
      }),
      this.prisma.userAchievement.groupBy({
        by: ['achievementId'],
        _count: { userId: true },
      }),
    ]);

    const progressMap = Object.fromEntries(
      progressCounts.map((p) => [p.achievementId, p._count.userId]),
    );
    const unlockMap = Object.fromEntries(
      unlockCounts.map((u) => [u.achievementId, u._count.userId]),
    );

    return definitions.map((def) => {
      const started = progressMap[def.id] ?? 0;
      const completed = unlockMap[def.id] ?? 0;
      const rate = started > 0 ? Math.round((completed / started) * 100 * 100) / 100 : 0;
      return { achievementId: def.id, code: def.code, name: def.name, started, completed, rate };
    });
  }

  async getUserAchievementHistory(userId: string, limit = 50, offset = 0) {
    const [items, total] = await Promise.all([
      this.prisma.achievementHistory.findMany({
        where: { userId },
        include: { achievement: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.achievementHistory.count({ where: { userId } }),
    ]);
    return { items, total, limit, offset };
  }

  async getAchievementsByCategory(category: string) {
    return this.prisma.achievementDefinition.findMany({
      where: { category, status: 'ACTIVE' },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
  }
}
