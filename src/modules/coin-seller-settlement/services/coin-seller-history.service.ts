import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface HistoryQueryDto {
  page?: number;
  limit?: number;
}

@Injectable()
export class CoinSellerHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves paginated settlements for a coin seller.
   */
  async getSellerSettlementHistory(sellerId: string, query: HistoryQueryDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where = sellerId ? { sellerId } : {};

    const [total, items] = await Promise.all([
      this.prisma.coinSellerSettlement.count({ where }),
      this.prisma.coinSellerSettlement.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formatted = items.map((i) => ({
      ...i,
      purchaseAmountCoins: i.purchaseAmountCoins.toString(),
      sellerCommissionCoins: i.sellerCommissionCoins.toString(),
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
