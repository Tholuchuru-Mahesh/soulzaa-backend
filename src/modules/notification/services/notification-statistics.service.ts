import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class NotificationStatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  private buildDateKey(date: Date = new Date()): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  }

  async incrementStat(
    channel: string,
    field: 'sentCount' | 'readCount' | 'failedCount',
  ): Promise<void> {
    const dateKey = this.buildDateKey();
    const increment = { [field]: { increment: 1 } };

    await this.prisma.notificationStatistics.upsert({
      where: {
        period_dateKey_channel: {
          period: 'DAILY',
          dateKey,
          channel,
        },
      },
      create: {
        period: 'DAILY',
        dateKey,
        channel,
        sentCount: field === 'sentCount' ? 1 : 0,
        readCount: field === 'readCount' ? 1 : 0,
        failedCount: field === 'failedCount' ? 1 : 0,
      },
      update: increment,
    });
  }

  async getSummary(period: string, dateKey: string): Promise<unknown[]> {
    return this.prisma.notificationStatistics.findMany({
      where: { period, dateKey },
    });
  }

  async getGlobalRates(): Promise<{
    sent: number;
    read: number;
    failed: number;
    readRate: number;
    deliveryRate: number;
    failureRate: number;
  }> {
    const aggregations = await this.prisma.notificationStatistics.aggregate({
      _sum: {
        sentCount: true,
        readCount: true,
        failedCount: true,
      },
    });

    const sent = aggregations._sum.sentCount ?? 0;
    const read = aggregations._sum.readCount ?? 0;
    const failed = aggregations._sum.failedCount ?? 0;

    const readRate = sent > 0 ? Math.round((read / sent) * 100 * 100) / 100 : 0;
    const deliveryRate = sent > 0 ? Math.round(((sent - failed) / sent) * 100 * 100) / 100 : 0;
    const failureRate = sent > 0 ? Math.round((failed / sent) * 100 * 100) / 100 : 0;

    return { sent, read, failed, readRate, deliveryRate, failureRate };
  }

  async getChannelUsageBreakdown(): Promise<unknown[]> {
    return this.prisma.notificationHistory.groupBy({
      by: ['channel'],
      _count: { channel: true },
    } as any);
  }

  async getTemplateUsageBreakdown(): Promise<unknown[]> {
    return this.prisma.enterpriseNotification.groupBy({
      by: ['type'],
      _count: { type: true },
    } as any);
  }
}
