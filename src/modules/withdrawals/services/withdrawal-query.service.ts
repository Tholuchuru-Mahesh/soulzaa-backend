import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WithdrawalStatus } from '@prisma/client';

@Injectable()
export class WithdrawalQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves global withdrawal summary metrics.
   */
  async getGlobalSummary() {
    const [totalRequests, pendingCount, aggCompleted, aggPending] = await Promise.all([
      this.prisma.withdrawalRequest.count(),
      this.prisma.withdrawalRequest.count({ where: { status: WithdrawalStatus.PENDING } }),
      this.prisma.withdrawalRequest.aggregate({
        where: { status: WithdrawalStatus.COMPLETED },
        _sum: { amountCoins: true, netPayoutAmountCoins: true },
      }),
      this.prisma.withdrawalRequest.aggregate({
        where: { status: { in: [WithdrawalStatus.PENDING, WithdrawalStatus.UNDER_REVIEW, WithdrawalStatus.APPROVED, WithdrawalStatus.PROCESSING] } },
        _sum: { amountCoins: true },
      }),
    ]);

    return {
      totalRequests,
      pendingRequestsCount: pendingCount,
      totalCompletedCoins: (aggCompleted._sum.amountCoins ?? BigInt(0)).toString(),
      totalCompletedNetPayoutCoins: (
        aggCompleted._sum.netPayoutAmountCoins ?? BigInt(0)
      ).toString(),
      totalPendingCoins: (aggPending._sum.amountCoins ?? BigInt(0)).toString(),
    };
  }

  /**
   * Retrieves pending withdrawal requests for admin review.
   */
  async getPendingReviewQueue(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { status: { in: [WithdrawalStatus.PENDING, WithdrawalStatus.UNDER_REVIEW] } };

    const [total, items] = await Promise.all([
      this.prisma.withdrawalRequest.count({ where }),
      this.prisma.withdrawalRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: items.map((i) => ({
        ...i,
        amountCoins: i.amountCoins.toString(),
        processingFeeCoins: i.processingFeeCoins.toString(),
        netPayoutAmountCoins: i.netPayoutAmountCoins.toString(),
      })),
    };
  }
}
