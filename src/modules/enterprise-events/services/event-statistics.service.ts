import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class EventStatisticsService {
  private readonly logger = new Logger(EventStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get todayKey() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  async incrementRegistrations(category: string, count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.eventStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { totalRegistrations: { increment: count } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        activeEvents: 0,
        completedEvents: 0,
        totalRegistrations: count,
        totalParticipants: 0,
        totalRewardsDispatched: 0,
      },
    });
  }

  async incrementParticipants(category: string, count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.eventStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { totalParticipants: { increment: count } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        activeEvents: 0,
        completedEvents: 0,
        totalRegistrations: 0,
        totalParticipants: count,
        totalRewardsDispatched: 0,
      },
    });
  }

  async incrementRewardsDispatched(category: string, count = 1) {
    const dateKey = this.todayKey;
    await this.prisma.eventStatistics.upsert({
      where: { period_dateKey_category: { period: 'DAILY', dateKey, category } },
      update: { totalRewardsDispatched: { increment: count } },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        activeEvents: 0,
        completedEvents: 0,
        totalRegistrations: 0,
        totalParticipants: 0,
        totalRewardsDispatched: count,
      },
    });
  }

  async getPlatformSummary() {
    const [activeEvents, completedEvents, totalRegistrations, totalParticipants, totalRewards] =
      await Promise.all([
        this.prisma.eventDefinition.count({ where: { status: 'ACTIVE' } }),
        this.prisma.eventDefinition.count({ where: { status: 'COMPLETED' } }),
        this.prisma.eventRegistration.count({ where: { status: 'REGISTERED' } }),
        this.prisma.eventParticipant.count(),
        this.prisma.eventReward.count({ where: { dispatched: true } }),
      ]);

    const completionRate =
      totalRegistrations > 0
        ? Math.round((totalParticipants / totalRegistrations) * 100 * 100) / 100
        : 0;

    return {
      activeEvents,
      completedEvents,
      totalRegistrations,
      totalParticipants,
      totalRewards,
      completionRate,
    };
  }

  async getCategoryStatistics(category: string, limit = 30) {
    return this.prisma.eventStatistics.findMany({
      where: { category },
      orderBy: { dateKey: 'desc' },
      take: limit,
    });
  }
}
