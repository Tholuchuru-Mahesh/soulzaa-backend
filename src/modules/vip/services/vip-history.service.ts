import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface HistoryQueryDto {
  page?: number;
  limit?: number;
}

@Injectable()
export class VipHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves paginated VIP lifecycle history for a user or global.
   */
  async getHistory(userId?: string, query: HistoryQueryDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = userId ? { userId } : {};

    const [total, items] = await Promise.all([
      this.prisma.vipHistory.count({ where }),
      this.prisma.vipHistory.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }
}
