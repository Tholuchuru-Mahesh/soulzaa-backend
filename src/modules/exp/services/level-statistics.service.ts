import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class LevelStatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  async updateStatistics(expAmount: number, levelUps: number = 0) {
    const todayStr = new Date().toISOString().split('T')[0];

    await this.prisma.levelStatistics.upsert({
      where: {
        period_dateKey: {
          period: 'DAILY',
          dateKey: todayStr,
        },
      },
      update: {
        totalExpGranted: { increment: BigInt(expAmount) },
        levelUpsCount: { increment: levelUps },
      },
      create: {
        period: 'DAILY',
        dateKey: todayStr,
        totalExpGranted: BigInt(expAmount),
        levelUpsCount: levelUps,
        activeUsersCount: 1,
      },
    });
  }

  async getSummaryStatistics() {
    const totalUsers = await this.prisma.userLevel.count();
    const statsAgg = await this.prisma.userLevel.aggregate({
      _avg: { currentLevel: true },
      _max: { currentLevel: true },
      _sum: { lifetimeExp: true },
    });

    const recentDaily = await this.prisma.levelStatistics.findMany({
      where: { period: 'DAILY' },
      orderBy: { dateKey: 'desc' },
      take: 30,
    });

    return {
      totalUsers,
      averageLevel: Number((statsAgg._avg.currentLevel ?? 1).toFixed(2)),
      highestLevel: statsAgg._max.currentLevel ?? 1,
      totalExpGranted: (statsAgg._sum.lifetimeExp ?? BigInt(0)).toString(),
      recentDaily,
    };
  }
}
