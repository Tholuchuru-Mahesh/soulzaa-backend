import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LedgerQueryDto, TransactionQueryFilterDto, WalletQueryDto } from '../dto/wallet-query.dto';
import { BalanceService } from './balance.service';
import { WalletService } from './wallet.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

@Injectable()
export class TransactionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly balanceService: BalanceService,
    private readonly media: MediaUrlResolver,
  ) {}

  /**
   * List and filter wallet accounts
   */
  async listWallets(dto: WalletQueryDto) {
    const { userId, type, status, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId?.trim()) {
      where.userId = userId.trim();
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
      availableBalance: (w.goldBalance - w.reservedBalance).toString(),
      reservedBalance: w.reservedBalance.toString(),
      pendingBalance: w.pendingBalance.toString(),
      lockedBalance: w.lockedBalance.toString(),
      goldBalance: w.goldBalance.toString(),
      freeBalance: w.freeBalance.toString(),
      earningsBalance: w.earningsBalance.toString(),
      totalSpent: w.totalSpent.toString(),
      totalRecharged: w.totalRecharged.toString(),
      totalGiftsSentValue: w.totalGiftsSentValue.toString(),
      totalGiftsReceivedValue: w.totalGiftsReceivedValue.toString(),
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
    const { transactionType, currency, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {
      ledgerEntries: {
        some: {
          walletId: wallet.id,
        },
      },
    };

    if (transactionType) {
      const typeUpper = transactionType.toUpperCase();
      if (typeUpper === 'GIFT') {
        where.ledgerEntries.some.reason = {
          in: ['GIFT_SEND', 'GIFT_RECEIVE'],
        };
      } else if (typeUpper === 'GIFT_SEND') {
        where.ledgerEntries.some.reason = 'GIFT_SEND';
      } else if (typeUpper === 'GIFT_RECEIVE') {
        where.ledgerEntries.some.reason = 'GIFT_RECEIVE';
      } else if (typeUpper === 'GAME_ENTRY') {
        where.ledgerEntries.some.reason = {
          in: ['GAME_STAKE', 'GAME_PAYOUT'],
        };
      } else if (typeUpper === 'COSMETIC_PURCHASE') {
        where.ledgerEntries.some.reason = 'COSMETIC_PURCHASE';
      } else {
        where.transactionType = typeUpper;
      }
    }
    if (currency) {
      where.currency = currency.toUpperCase();
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

    const txIds = txs.map((t) => t.id);

    // Fetch related purchase orders, withdrawal requests, and gift transactions in parallel
    const [purchaseOrders, withdrawalRequests, giftTransactions] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: {
          walletTransactionId: { in: txIds },
        },
        include: {
          package: true,
        },
      }),
      this.prisma.withdrawalRequest.findMany({
        where: {
          OR: [{ payoutTxnId: { in: txIds } }, { holdTxnId: { in: txIds } }],
        },
      }),
      this.prisma.giftTransaction.findMany({
        where: {
          OR: [{ senderWalletTxnId: { in: txIds } }, { receiverWalletTxnId: { in: txIds } }],
        },
      }),
    ]);

    // Query gifts and user profiles in memory to bypass missing schema relations
    const giftIds = [...new Set(giftTransactions.map((gt) => gt.giftId))];
    const userIds = [
      ...new Set([
        ...giftTransactions.map((gt) => gt.senderId),
        ...giftTransactions.map((gt) => gt.receiverId),
      ]),
    ];

    const [gifts, users] = await Promise.all([
      this.prisma.gift.findMany({ where: { id: { in: giftIds } } }),
      this.prisma.user.findMany({ where: { id: { in: userIds } } }),
    ]);

    const giftMap = new Map(gifts.map((g) => [g.id, g]));
    const userMap = new Map(users.map((u) => [u.id, u]));

    const poMap = new Map(
      purchaseOrders
        .filter((po) => po.walletTransactionId)
        .map((po) => [po.walletTransactionId!, po]),
    );
    const wrMap = new Map();
    for (const wr of withdrawalRequests) {
      if (wr.payoutTxnId) wrMap.set(wr.payoutTxnId, wr);
      if (wr.holdTxnId) wrMap.set(wr.holdTxnId, wr);
    }
    const gtMap = new Map();
    for (const gt of giftTransactions) {
      if (gt.senderWalletTxnId) gtMap.set(gt.senderWalletTxnId, gt);
      if (gt.receiverWalletTxnId) gtMap.set(gt.receiverWalletTxnId, gt);
    }

    const items = await Promise.all(
      txs.map(async (t) => {
        const po = poMap.get(t.id);
        const wr = wrMap.get(t.id);
        const gt = gtMap.get(t.id);

        // Construct a rich payment/details block
        let paymentDetails: any = null;
        if (po) {
          paymentDetails = {
            priceAmount: po.priceAmount.toString(),
            currency: po.currency,
            provider: po.provider,
            orderNumber: po.orderNumber,
            packageName: po.package?.name,
          };
        } else if (wr) {
          paymentDetails = {
            payoutAmountCoins: wr.netPayoutAmountCoins.toString(),
            payoutMethod: wr.payoutMethod,
            payoutDetails: wr.payoutDetails,
            status: wr.status,
          };
        } else if (gt) {
          const gift = giftMap.get(gt.giftId);
          const sender = userMap.get(gt.senderId);
          const receiver = userMap.get(gt.receiverId);
          paymentDetails = {
            giftName: gift?.displayName || gift?.name || 'Gift',
            giftThumbnailUrl: await this.media.resolve(gift?.thumbnailUrl) || null,
            quantity: gt.quantity,
            senderName: sender?.username || 'user',
            receiverName: receiver?.username || 'user',
          };
        }

        return {
          ...t,
          amount: t.amount.toString(),
          paymentDetails,
          ledgerEntries: t.ledgerEntries.map((e) => ({
            ...e,
            amount: e.amount.toString(),
            balanceBefore: e.balanceBefore.toString(),
            balanceAfter: e.balanceAfter.toString(),
          })),
        };
      })
    );

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
