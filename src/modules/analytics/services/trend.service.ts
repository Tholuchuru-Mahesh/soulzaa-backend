import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

export interface TrendQueryInput {
  domain: string;
  metricKey: string;
  startDate: Date;
  endDate: Date;
}

@Injectable()
export class TrendService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves time-series trend snapshots.
   */
  async getTrendData(input: TrendQueryInput): Promise<unknown[]> {
    return this.prisma.analyticsSnapshot.findMany({
      where: {
        domain: input.domain,
        metricKey: input.metricKey,
        timestamp: {
          gte: input.startDate,
          lte: input.endDate,
        },
      },
      orderBy: { timestamp: 'asc' },
    });
  }

  /**
   * Computes period-over-period growth ratios.
   */
  async calculateGrowthRatio(
    domain: string,
    metricKey: string,
    currentStart: Date,
    currentEnd: Date,
    priorStart: Date,
    priorEnd: Date,
  ): Promise<{ ratio: number; currentAvg: number; priorAvg: number }> {
    const [currentAvgObj, priorAvgObj] = await Promise.all([
      this.prisma.analyticsSnapshot.aggregate({
        where: { domain, metricKey, timestamp: { gte: currentStart, lte: currentEnd } },
        _avg: { metricValue: true },
      }),
      this.prisma.analyticsSnapshot.aggregate({
        where: { domain, metricKey, timestamp: { gte: priorStart, lte: priorEnd } },
        _avg: { metricValue: true },
      }),
    ]);

    const currentAvg = currentAvgObj._avg.metricValue ?? 0;
    const priorAvg = priorAvgObj._avg.metricValue ?? 0;

    if (priorAvg === 0) return { ratio: 0, currentAvg, priorAvg };

    const ratio = Math.round(((currentAvg - priorAvg) / priorAvg) * 100 * 100) / 100;
    return { ratio, currentAvg, priorAvg };
  }
}
