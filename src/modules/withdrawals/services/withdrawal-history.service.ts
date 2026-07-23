import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface WithdrawalHistoryQueryDto {
  page?: number;
  limit?: number;
  status?: string;
}

@Injectable()
export class WithdrawalHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves paginated withdrawal history for a user or globally for admins.
   */
  async getWithdrawalHistory(userId?: string, query: WithdrawalHistoryQueryDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId) where.userId = userId;
    if (query.status) where.status = query.status;

    const [total, items] = await Promise.all([
      this.prisma.withdrawalRequest.count({ where }),
      this.prisma.withdrawalRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formatted = items.map((i) => ({
      ...i,
      amountCoins: i.amountCoins.toString(),
      processingFeeCoins: i.processingFeeCoins.toString(),
      netPayoutAmountCoins: i.netPayoutAmountCoins.toString(),
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
   * Retrieves state transition history for a specific request.
   */
  async getRequestStateTransitions(requestId: string) {
    return this.prisma.withdrawalHistory.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
