import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LedgerQueryDto, TransactionQueryFilterDto, WalletQueryDto } from '../dto/wallet-query.dto';
import { BalanceService } from './balance.service';
import { WalletService } from './wallet.service';

@Injectable()
export class TransactionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly balanceService: BalanceService,
  ) {}

  /**
   * List and filter wallet accounts
   */
  async listWallets(dto: WalletQueryDto) {
    const { userId, type, status, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId?.trim()) {
      where.userId = { contains: userId.trim(), mode: 'insensitive' };
    }
    if (type) {
      where.type = type.toUpperCase();
    }
    if (status) {
      where.status = status.toUpperCase();
    }

    const [total, items] = await Promise.all([
      this.prisma.wallet.count({ where }),
      this.prisma.wallet.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formattedItems = items.map((w) => ({
      ...w,
      availableBalance: w.availableBalance.toString(),
      reservedBalance: w.reservedBalance.toString(),
      pendingBalance: w.pendingBalance.toString(),
      lockedBalance: w.lockedBalance.toString(),
      goldBalance: w.goldBalance.toString(),
      freeBalance: w.freeBalance.toString(),
      earningsBalance: w.earningsBalance.toString(),
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items: formattedItems,
    };
  }

  /**
   * Get single wallet details & balance projection
   */
  async getWalletDetails(walletId: string) {
    return this.balanceService.getBalanceProjection(walletId);
  }

  /**
   * Get immutable ledger entries for a wallet
   */
  async getLedgerHistory(walletId: string, dto: LedgerQueryDto) {
    await this.walletService.getWalletById(walletId);

    const { type, reason, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = { walletId };
    if (type) where.type = type.toUpperCase();
    if (reason) where.reason = reason.toUpperCase();

    const [total, entries] = await Promise.all([
      this.prisma.ledgerEntry.count({ where }),
      this.prisma.ledgerEntry.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const items = entries.map((e) => ({
      ...e,
      amount: e.amount.toString(),
      balanceBefore: e.balanceBefore.toString(),
      balanceAfter: e.balanceAfter.toString(),
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  /**
   * Get transaction history for a wallet
   */
  async getTransactionHistory(walletId: string, dto: TransactionQueryFilterDto) {
    const wallet = await this.walletService.getWalletById(walletId);
    const { transactionType, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {
      OR: [{ sourceWalletId: wallet.id }, { destinationWalletId: wallet.id }],
    };

    if (transactionType) {
      where.transactionType = transactionType.toUpperCase();
    }

    const [total, txs] = await Promise.all([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { ledgerEntries: true },
      }),
    ]);

    const items = txs.map((t) => ({
      ...t,
      amount: t.amount.toString(),
      ledgerEntries: t.ledgerEntries.map((e) => ({
        ...e,
        amount: e.amount.toString(),
        balanceBefore: e.balanceBefore.toString(),
        balanceAfter: e.balanceAfter.toString(),
      })),
    }));

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  /**
   * Get single transaction details & ledger entries
   */
  async getTransactionDetails(transactionId: string) {
    const tx = await this.prisma.walletTransaction.findUnique({
      where: { id: transactionId },
      include: { ledgerEntries: true },
    });

    if (!tx) {
      throw new NotFoundException(`Transaction '${transactionId}' not found`);
    }

    return {
      ...tx,
      amount: tx.amount.toString(),
      ledgerEntries: tx.ledgerEntries.map((e) => ({
        ...e,
        amount: e.amount.toString(),
        balanceBefore: e.balanceBefore.toString(),
        balanceAfter: e.balanceAfter.toString(),
      })),
    };
  }

  /**
   * List coin reservations for a wallet
   */
  async listReservations(walletId: string) {
    await this.walletService.getWalletById(walletId);

    const reservations = await this.prisma.walletReservation.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
    });

    return reservations.map((r) => ({
      ...r,
      amount: r.amount.toString(),
    }));
  }

  /**
   * Platform wallet ecosystem overview summary
   */
  async getWalletEcosystemSummary() {
    const [totalWallets, aggregateStats] = await Promise.all([
      this.prisma.wallet.count(),
      this.prisma.wallet.aggregate({
        _sum: {
          availableBalance: true,
          reservedBalance: true,
          pendingBalance: true,
          lockedBalance: true,
        },
      }),
    ]);

    const avail = aggregateStats._sum.availableBalance ?? BigInt(0);
    const res = aggregateStats._sum.reservedBalance ?? BigInt(0);
    const pend = aggregateStats._sum.pendingBalance ?? BigInt(0);
    const lock = aggregateStats._sum.lockedBalance ?? BigInt(0);

    return {
      totalWallets,
      totalAvailableBalance: avail.toString(),
      totalReservedBalance: res.toString(),
      totalPendingBalance: pend.toString(),
      totalLockedBalance: lock.toString(),
      totalEcosystemCoins: (avail + res + pend + lock).toString(),
      lastCalculatedAt: new Date(),
    };
  }
}
