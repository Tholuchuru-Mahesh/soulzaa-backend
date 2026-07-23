import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TaskStatisticsService {
  private readonly logger = new Logger(TaskStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get todayKey() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  async incrementCompletedTasks(category: string, count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.taskStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { completedTasks: { increment: count } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        activeTasks: 0,
        completedTasks: count,
        completedMissions: 0,
        rewardsDispatched: 0,
      },
    });
  }

  async incrementCompletedMissions(category: string, count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.taskStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { completedMissions: { increment: count } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        activeTasks: 0,
        completedTasks: 0,
        completedMissions: count,
        rewardsDispatched: 0,
      },
    });
  }

  async incrementRewardsDispatched(category: string, count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.taskStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { rewardsDispatched: { increment: count } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        activeTasks: 0,
        completedTasks: 0,
        completedMissions: 0,
        rewardsDispatched: count,
      },
    });
  }

  async getPlatformSummary() {
    const [activeTasks, completedTasks, completedMissions, rewardsDispatched, totalProgressRows] =
      await Promise.all([
        this.prisma.taskDefinition.count({ where: { status: 'ACTIVE' } }),
        this.prisma.taskProgress.count({ where: { isCompleted: true } }),
        this.prisma.missionProgress.count({ where: { isCompleted: true } }),
        this.prisma.taskReward.count({ where: { claimed: true } }),
        this.prisma.taskProgress.count(),
      ]);

    const completionRate =
      totalProgressRows > 0
        ? Math.round((completedTasks / totalProgressRows) * 100 * 100) / 100
        : 0;

    return {
      activeTasks,
      completedTasks,
      completedMissions,
      rewardsDispatched,
      totalProgressRows,
      completionRate,
    };
  }

  async getCategoryStatistics(category: string, limit = 30) {
    return this.prisma.taskStatistics.findMany({
      where: { category },
      orderBy: { dateKey: 'desc' },
      take: limit,
    });
  }
}
