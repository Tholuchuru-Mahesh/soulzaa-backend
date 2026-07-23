import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class DashboardStatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  private buildDateKey(date: Date = new Date()): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  }

  async incrementStat(
    field: 'widgetRefreshes' | 'alertsRaised' | 'exportsCount',
    count = 1,
    period = 'DAILY',
  ): Promise<void> {
    const dateKey = this.buildDateKey();
    const increment = { [field]: { increment: count } };

    await this.prisma.dashboardStatistics.upsert({
      where: {
        period_dateKey: {
          period,
          dateKey,
        },
      },
      create: {
        period,
        dateKey,
        widgetRefreshes: field === 'widgetRefreshes' ? count : 0,
        alertsRaised: field === 'alertsRaised' ? count : 0,
        exportsCount: field === 'exportsCount' ? count : 0,
      },
      update: increment,
    });
  }

  async getSummary(period: string, dateKey: string): Promise<unknown> {
    return this.prisma.dashboardStatistics.findUnique({
      where: {
        period_dateKey: { period, dateKey },
      },
    });
  }
}
