import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface HistoryQueryDto {
  page?: number;
  limit?: number;
}

@Injectable()
export class AgencyHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves paginated settlements for an agency.
   */
  async getAgencySettlementHistory(agencyId: string, query: HistoryQueryDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = agencyId ? { agencyId } : {};

    const [total, items] = await Promise.all([
      this.prisma.agencySettlement.count({ where }),
      this.prisma.agencySettlement.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formatted = items.map((i) => ({
      ...i,
      hostEarningsCoins: i.hostEarningsCoins.toString(),
      agencyCommissionCoins: i.agencyCommissionCoins.toString(),
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
