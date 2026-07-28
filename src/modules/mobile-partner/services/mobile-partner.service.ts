import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const num = (value: unknown): number => Number(value ?? 0);

/**
 * Mobile read models for external partners — agencies, coin sellers and hosts.
 *
 * Every query is keyed on the authenticated user's own id. There is no route
 * that takes a partner id, so one agency cannot read another's commission by
 * changing a parameter — the ownership boundary is structural rather than a
 * check that could be forgotten.
 *
 * A caller who is not, say, an agency simply has no agency rows and gets an
 * empty result, so the same surface is safe for every partner role.
 */
@Injectable()
export class MobilePartnerService {
  private readonly logger = new Logger(MobilePartnerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Agency view: commission earned and the hosts signed to me. */
  async agencySummary(userId: string, hostLimit = 50) {
    const [totals, settlementCount, hosts] = await Promise.all([
      this.prisma.agencySettlement.aggregate({
        where: { agencyId: userId },
        _sum: { hostEarningsCoins: true, agencyCommissionCoins: true },
      }),
      this.prisma.agencySettlement.count({ where: { agencyId: userId } }),
      this.prisma.agencyRelationship.findMany({
        where: { agencyId: userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        take: Math.min(hostLimit, 200),
        select: { hostId: true, status: true, effectiveFrom: true },
      }),
    ]);

    return {
      settlements: settlementCount,
      hostEarningsGenerated: num(totals._sum.hostEarningsCoins),
      commissionEarned: num(totals._sum.agencyCommissionCoins),
      activeHosts: hosts,
    };
  }

  /** Agency settlement history, newest first. */
  async agencySettlements(userId: string, limit = 25, offset = 0) {
    const where = { agencyId: userId };

    const [total, items] = await Promise.all([
      this.prisma.agencySettlement.count({ where }),
      this.prisma.agencySettlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
      }),
    ]);

    return { total, items };
  }

  /** Coin seller view: sales volume and commission earned. */
  async sellerSummary(userId: string, buyerLimit = 50) {
    const [totals, settlementCount, buyers] = await Promise.all([
      this.prisma.coinSellerSettlement.aggregate({
        where: { sellerId: userId },
        _sum: { purchaseAmountCoins: true, sellerCommissionCoins: true },
      }),
      this.prisma.coinSellerSettlement.count({ where: { sellerId: userId } }),
      this.prisma.coinSellerRelationship.findMany({
        where: { sellerId: userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        take: Math.min(buyerLimit, 200),
        select: { buyerId: true, status: true, effectiveFrom: true },
      }),
    ]);

    return {
      settlements: settlementCount,
      salesVolume: num(totals._sum.purchaseAmountCoins),
      commissionEarned: num(totals._sum.sellerCommissionCoins),
      activeBuyers: buyers,
    };
  }

  /** Coin seller settlement history, newest first. */
  async sellerSettlements(userId: string, limit = 25, offset = 0) {
    const where = { sellerId: userId };

    const [total, items] = await Promise.all([
      this.prisma.coinSellerSettlement.count({ where }),
      this.prisma.coinSellerSettlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
      }),
    ]);

    return { total, items };
  }

  /** Host view: lifetime earnings, withdrawable balance and agency, if any. */
  async hostEarnings(userId: string) {
    const [earnings, wallet, agency, withdrawals] = await Promise.all([
      this.prisma.hostEarnings.findUnique({ where: { hostId: userId } }),
      this.prisma.wallet.findUnique({
        where: { userId },
        select: { earningsBalance: true, availableBalance: true },
      }),
      this.prisma.agencyRelationship.findFirst({
        where: { hostId: userId, status: 'ACTIVE' },
        select: { agencyId: true, effectiveFrom: true },
      }),
      this.prisma.withdrawalRequest.groupBy({
        by: ['status'],
        where: { userId },
        _count: { _all: true },
        _sum: { amountCoins: true },
      }),
    ]);

    return {
      lifetimeEarnings: num(earnings?.totalEarnedCoins),
      giftsReceived: earnings?.totalGiftCount ?? 0,
      earningsBalance: num(wallet?.earningsBalance),
      availableBalance: num(wallet?.availableBalance),
      // Null when the host is independent rather than signed to an agency.
      agency,
      withdrawals: withdrawals.map((row) => ({
        status: row.status,
        count: row._count._all,
        totalCoins: num(row._sum.amountCoins),
      })),
    };
  }

  /** Gift transactions the host received, newest first. */
  async hostGiftHistory(userId: string, limit = 25, offset = 0) {
    const where = { receiverId: userId };

    const [total, items] = await Promise.all([
      this.prisma.giftTransaction.count({ where }),
      this.prisma.giftTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
        select: {
          id: true,
          giftId: true,
          senderId: true,
          quantity: true,
          totalCoinValue: true,
          creatorEarnings: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      total,
      items: items.map((tx) => ({
        ...tx,
        totalCoinValue: num(tx.totalCoinValue),
        creatorEarnings: num(tx.creatorEarnings),
      })),
    };
  }
}
