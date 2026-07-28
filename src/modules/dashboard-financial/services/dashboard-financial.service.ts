import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Prisma returns BigInt/Decimal sums; dashboards serialise plain numbers. */
const num = (value: unknown): number => Number(value ?? 0);

export interface DashboardRange {
  /** Inclusive lower bound. Omitted means all time. */
  since?: Date;
}

/**
 * Read models for the financial dashboards.
 *
 * Strictly read-only: the console orchestrates and visualises the finance
 * engines, it does not own their rules. Nothing here writes, and no balance or
 * settlement is ever recomputed — a figure the dashboard derived itself would
 * eventually disagree with the ledger that actually paid people.
 */
@Injectable()
export class DashboardFinancialService {
  private readonly logger = new Logger(DashboardFinancialService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Cross-cutting money view: float held, earned, and paid out. */
  async financialOverview(range: DashboardRange = {}) {
    const createdAt = range.since ? { gte: range.since } : undefined;

    const [wallets, revenue, withdrawals, purchases] = await Promise.all([
      this.prisma.wallet.aggregate({ _sum: { availableBalance: true, lockedBalance: true } }),
      this.prisma.revenueDistribution.aggregate({
        _sum: { totalCoinValue: true, hostEarningsCoins: true, platformEarningsCoins: true },
        where: createdAt ? { createdAt } : undefined,
      }),
      this.prisma.withdrawalRequest.aggregate({
        _sum: { amountCoins: true },
        where: { status: 'COMPLETED', ...(createdAt ? { createdAt } : {}) },
      }),
      this.prisma.purchaseOrder.aggregate({
        _sum: { totalCoins: true },
        where: { status: 'COMPLETED', ...(createdAt ? { createdAt } : {}) },
      }),
    ]);

    return {
      coinsInCirculation: num(wallets._sum.availableBalance),
      coinsLocked: num(wallets._sum.lockedBalance),
      coinsPurchased: num(purchases._sum.totalCoins),
      grossGiftValue: num(revenue._sum.totalCoinValue),
      hostEarnings: num(revenue._sum.hostEarningsCoins),
      platformEarnings: num(revenue._sum.platformEarningsCoins),
      coinsWithdrawn: num(withdrawals._sum.amountCoins),
    };
  }

  /** Wallet management: distribution of balances and recent ledger volume. */
  async walletDashboard() {
    const [totals, walletCount, byCurrency, ledgerEntries] = await Promise.all([
      this.prisma.wallet.aggregate({ _sum: { availableBalance: true, lockedBalance: true } }),
      this.prisma.wallet.count(),
      this.prisma.wallet.groupBy({
        by: ['status'],
        _sum: { availableBalance: true },
        _count: { _all: true },
      }),
      this.prisma.walletTransaction.count(),
    ]);

    return {
      totalWallets: walletCount,
      totalAvailable: num(totals._sum.availableBalance),
      totalLocked: num(totals._sum.lockedBalance),
      totalTransactions: ledgerEntries,
      byStatus: byCurrency.map((row) => ({
        status: row.status,
        wallets: row._count._all,
        available: num(row._sum.availableBalance),
      })),
    };
  }

  /** Treasury monitoring: platform coin economy position and policy state. */
  async treasuryDashboard() {
    const [reserve, policies, recentLog] = await Promise.all([
      this.prisma.treasuryReserve.findFirst({ orderBy: { createdAt: 'asc' } }),
      this.prisma.financialPolicy.findMany({ orderBy: { key: 'asc' } }),
      this.prisma.treasuryLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);

    return {
      reserve: reserve
        ? {
            maxSupply: num(reserve.maxSupply),
            circulatingSupply: num(reserve.circulatingSupply),
            reservedSupply: num(reserve.reservedSupply),
            treasuryBalance: num(reserve.treasuryBalance),
            // Surfaced prominently: while frozen, purchases and payouts refuse.
            isFrozen: reserve.isFrozen,
          }
        : null,
      policies: policies.map((p) => ({
        key: p.key,
        name: p.name,
        category: p.category,
        value: num(p.value),
        isEditable: p.isEditable,
      })),
      recentLog,
    };
  }

  /** Revenue dashboard: distribution volume and the top earning hosts. */
  async revenueDashboard(range: DashboardRange = {}, topHosts = 10) {
    const where = range.since ? { createdAt: { gte: range.since } } : undefined;

    const [totals, count, leaders] = await Promise.all([
      this.prisma.revenueDistribution.aggregate({
        _sum: { totalCoinValue: true, hostEarningsCoins: true, platformEarningsCoins: true },
        where,
      }),
      this.prisma.revenueDistribution.count({ where }),
      this.prisma.hostEarnings.findMany({
        orderBy: { totalEarnedCoins: 'desc' },
        take: topHosts,
      }),
    ]);

    return {
      distributions: count,
      grossValue: num(totals._sum.totalCoinValue),
      hostShare: num(totals._sum.hostEarningsCoins),
      platformShare: num(totals._sum.platformEarningsCoins),
      topHosts: leaders.map((h) => ({
        hostId: h.hostId,
        totalEarnings: num(h.totalEarnedCoins),
        giftCount: h.totalGiftCount,
      })),
    };
  }

  /** Withdrawal operations: the approval queue and payout throughput. */
  async withdrawalDashboard(pendingLimit = 25) {
    const [byStatus, paidOut, pending] = await Promise.all([
      this.prisma.withdrawalRequest.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { amountCoins: true },
      }),
      this.prisma.withdrawalRequest.aggregate({
        _sum: { netPayoutAmountCoins: true },
        where: { status: 'COMPLETED' },
      }),
      this.prisma.withdrawalRequest.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: pendingLimit,
      }),
    ]);

    return {
      byStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count._all,
        totalCoins: num(row._sum.amountCoins),
      })),
      netPaidOut: num(paidOut._sum.netPayoutAmountCoins),
      // Oldest first — the queue is worked front to back.
      pendingQueue: pending,
    };
  }

  /** Agency settlements: commission owed and paid, with the largest partners. */
  async agencyDashboard(topAgencies = 10) {
    const [relationships, settlements, totals, leaders] = await Promise.all([
      this.prisma.agencyRelationship.count(),
      this.prisma.agencySettlement.count(),
      this.prisma.agencySettlement.aggregate({
        _sum: { hostEarningsCoins: true, agencyCommissionCoins: true },
      }),
      this.prisma.agencySettlement.groupBy({
        by: ['agencyId'],
        _sum: { agencyCommissionCoins: true },
        orderBy: { _sum: { agencyCommissionCoins: 'desc' } },
        take: topAgencies,
      }),
    ]);

    return {
      relationships,
      settlements,
      hostEarnings: num(totals._sum.hostEarningsCoins),
      commissionPaid: num(totals._sum.agencyCommissionCoins),
      topAgencies: leaders.map((row) => ({
        agencyId: row.agencyId,
        commission: num(row._sum.agencyCommissionCoins),
      })),
    };
  }

  /** Coin seller settlements: sales volume and commission by seller. */
  async coinSellerDashboard(topSellers = 10) {
    const [relationships, settlements, totals, leaders] = await Promise.all([
      this.prisma.coinSellerRelationship.count(),
      this.prisma.coinSellerSettlement.count(),
      this.prisma.coinSellerSettlement.aggregate({
        _sum: { purchaseAmountCoins: true, sellerCommissionCoins: true },
      }),
      this.prisma.coinSellerSettlement.groupBy({
        by: ['sellerId'],
        _sum: { sellerCommissionCoins: true },
        orderBy: { _sum: { sellerCommissionCoins: 'desc' } },
        take: topSellers,
      }),
    ]);

    return {
      relationships,
      settlements,
      purchaseVolume: num(totals._sum.purchaseAmountCoins),
      commissionPaid: num(totals._sum.sellerCommissionCoins),
      topSellers: leaders.map((row) => ({
        sellerId: row.sellerId,
        commission: num(row._sum.sellerCommissionCoins),
      })),
    };
  }
}
