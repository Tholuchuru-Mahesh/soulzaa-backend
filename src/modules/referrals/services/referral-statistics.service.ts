import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class ReferralStatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  private buildDateKey(date: Date = new Date()): string {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  }

  async incrementStat(
    category: string,
    field: 'codesCreated' | 'registeredCount' | 'qualifiedCount' | 'rewardedCount',
  ): Promise<void> {
    const dateKey = this.buildDateKey();
    const increment: Record<string, { increment: number }> = {
      [field]: { increment: 1 },
    };
    await this.prisma.referralStatistics.upsert({
      where: {
        period_dateKey_category: { period: 'DAILY', dateKey, category },
      },
      create: {
        period: 'DAILY',
        dateKey,
        category,
        codesCreated: field === 'codesCreated' ? 1 : 0,
        registeredCount: field === 'registeredCount' ? 1 : 0,
        qualifiedCount: field === 'qualifiedCount' ? 1 : 0,
        rewardedCount: field === 'rewardedCount' ? 1 : 0,
      },
      update: increment,
    });
  }

  async getSummary(period: string, dateKey: string): Promise<unknown[]> {
    return this.prisma.referralStatistics.findMany({
      where: { period, dateKey },
    });
  }

  async getTopReferrers(limit = 10): Promise<unknown[]> {
    return this.prisma.referralRelationship.groupBy({
      by: ['referrerId'],
      where: { status: { in: ['QUALIFIED', 'REWARDED'] } },
      _count: { referrerId: true },
      orderBy: { _count: { referrerId: 'desc' } },
      take: limit,
    } as any);
  }

  async getConversionRate(campaignId?: string): Promise<number> {
    const where = campaignId ? { campaignId } : {};
    const total = await this.prisma.referralRelationship.count({ where });
    const qualified = await this.prisma.referralRelationship.count({
      where: { ...where, status: { in: ['QUALIFIED', 'REWARDED'] } },
    });
    if (total === 0) return 0;
    return Math.round((qualified / total) * 100 * 100) / 100;
  }

  async getCampaignPerformance(): Promise<unknown[]> {
    return this.prisma.referralRelationship.groupBy({
      by: ['campaignId', 'status'],
      _count: { campaignId: true },
      orderBy: { _count: { campaignId: 'desc' } },
    } as any);
  }
}
