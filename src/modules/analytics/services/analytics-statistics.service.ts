import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class AnalyticsStatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  private buildDateKey(date: Date = new Date()): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  }

  async incrementStat(
    metricType: string,
    count = 1,
    amount = 0.0,
    period = 'DAILY',
  ): Promise<void> {
    const dateKey = this.buildDateKey();

    await this.prisma.analyticsStatistics.upsert({
      where: {
        period_dateKey_metricType: {
          period,
          dateKey,
          metricType,
        },
      },
      create: {
        period,
        dateKey,
        metricType,
        count,
        amount,
      },
      update: {
        count: { increment: count },
        amount: { increment: amount },
      },
    });
  }

  async getSummary(period: string, dateKey: string): Promise<unknown[]> {
    return this.prisma.analyticsStatistics.findMany({
      where: { period, dateKey },
    });
  }

  async getMetricsByDateRange(
    metricType: string,
    startDateStr: string,
    endDateStr: string,
  ): Promise<unknown[]> {
    const startKey = startDateStr.replace(/-/g, '');
    const endKey = endDateStr.replace(/-/g, '');

    return this.prisma.analyticsStatistics.findMany({
      where: {
        metricType,
        dateKey: {
          gte: startKey,
          lte: endKey,
        },
      },
      orderBy: { dateKey: 'asc' },
    });
  }
}
