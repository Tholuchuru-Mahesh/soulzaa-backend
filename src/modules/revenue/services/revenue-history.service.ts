import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface HistoryQueryDto {
  page?: number;
  limit?: number;
}

@Injectable()
export class RevenueHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves paginated revenue distributions for a host.
   */
  async getHostDistributionHistory(hostId: string, query: HistoryQueryDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      this.prisma.revenueDistribution.count({ where: { hostId } }),
      this.prisma.revenueDistribution.findMany({
        where: { hostId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formatted = items.map((i) => ({
      ...i,
      totalCoinValue: i.totalCoinValue.toString(),
      hostEarningsCoins: i.hostEarningsCoins.toString(),
      platformEarningsCoins: i.platformEarningsCoins.toString(),
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: formatted,
    };
  }

  /**
   * Retrieves paginated room revenue distributions.
   */
  async getRoomRevenueHistory(contextId: string, query: HistoryQueryDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      this.prisma.revenueDistribution.count({ where: { contextId } }),
      this.prisma.revenueDistribution.findMany({
        where: { contextId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formatted = items.map((i) => ({
      ...i,
      totalCoinValue: i.totalCoinValue.toString(),
      hostEarningsCoins: i.hostEarningsCoins.toString(),
      platformEarningsCoins: i.platformEarningsCoins.toString(),
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: formatted,
    };
  }
}
