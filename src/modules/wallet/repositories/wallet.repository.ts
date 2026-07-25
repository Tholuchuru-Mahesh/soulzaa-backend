import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LedgerEntry,
  Prisma,
  Wallet,
  WalletCurrency,
  WalletEntryType,
  WalletTransaction,
  WalletTxnReason,
} from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface ApplyMovementInput {
  userId: string;
  currency: WalletCurrency;
  type: WalletEntryType;
  reason: WalletTxnReason;
  amount: bigint;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey: string;
  metadata?: Prisma.InputJsonValue;
  actorId?: string;
}

const BALANCE_FIELD: Record<WalletCurrency, keyof Wallet> = {
  GOLD: 'goldBalance',
  FREE: 'freeBalance',
  EARNINGS: 'earningsBalance',
};

@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  getWallet(userId: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  async ensureWallet(userId: string): Promise<void> {
    await this.prisma.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WalletTransaction | null> {
    const client = tx || this.prisma;
    return client.walletTransaction.findUnique({ where: { idempotencyKey } });
  }

  async listTransactions(
    userId: string,
    skip: number,
    take: number,
    currency?: WalletCurrency,
  ): Promise<[LedgerEntry[], number]> {
    const wallet = await this.getWallet(userId);
    if (!wallet) return [[], 0];
    const where: Prisma.LedgerEntryWhereInput = {
      walletId: wallet.id,
      ...(currency ? { currency } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.ledgerEntry.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
  }

  async listByReasons(
    userId: string,
    reasons: WalletTxnReason[],
    skip: number,
    take: number,
  ): Promise<[LedgerEntry[], number]> {
    const wallet = await this.getWallet(userId);
    if (!wallet) return [[], 0];
    const where: Prisma.LedgerEntryWhereInput = { walletId: wallet.id, reason: { in: reasons } };
    return this.prisma.$transaction([
      this.prisma.ledgerEntry.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
  }

  async sumByReason(
    userId: string,
    reasons: WalletTxnReason[],
    currency: WalletCurrency,
  ): Promise<Array<{ reason: WalletTxnReason; total: bigint }>> {
    const wallet = await this.getWallet(userId);
    if (!wallet) return [];
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['reason'],
      where: {
        walletId: wallet.id,
        currency,
        type: WalletEntryType.CREDIT,
        reason: { in: reasons },
      },
      _sum: { amount: true },
    });
    return rows.map((r) => ({ reason: r.reason, total: r._sum?.amount ?? 0n }));
  }

  async aggregateSignedByCurrency(
    userId: string,
  ): Promise<Array<{ currency: WalletCurrency; credited: bigint; debited: bigint }>> {
    const wallet = await this.getWallet(userId);
    if (!wallet) return [];
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['currency', 'type'],
      where: { walletId: wallet.id },
      _sum: { amount: true },
    });
    const acc = new Map<WalletCurrency, { credited: bigint; debited: bigint }>();
    for (const r of rows) {
      const cur = acc.get(r.currency) ?? { credited: 0n, debited: 0n };
      if (r.type === WalletEntryType.CREDIT) cur.credited += r._sum?.amount ?? 0n;
      else cur.debited += r._sum?.amount ?? 0n;
      acc.set(r.currency, cur);
    }
    return Array.from(acc.entries()).map(([currency, v]) => ({ currency, ...v }));
  }

  async listHistory(
    userId: string,
    filters: { currency?: WalletCurrency; reason?: WalletTxnReason },
    skip: number,
    take: number,
  ): Promise<[LedgerEntry[], number]> {
    const wallet = await this.getWallet(userId);
    if (!wallet) return [[], 0];
    const where: Prisma.LedgerEntryWhereInput = {
      walletId: wallet.id,
      ...(filters.currency ? { currency: filters.currency } : {}),
      ...(filters.reason ? { reason: filters.reason } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.ledgerEntry.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
  }

  async applyMovement(
    input: ApplyMovementInput,
    tx?: Prisma.TransactionClient,
  ): Promise<LedgerEntry> {
    const field = BALANCE_FIELD[input.currency];

    const run = async (t: Prisma.TransactionClient) => {
      await t.wallet.upsert({
        where: { userId: input.userId },
        create: { userId: input.userId },
        update: {},
      });
      const wallet = await t.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
      const before = (wallet[field] as unknown as bigint) ?? 0n;
      const delta = input.type === WalletEntryType.DEBIT ? -input.amount : input.amount;
      const after = before + delta;
      if (after < 0n) {
        throw new BusinessException(
          ERROR_CODES.INSUFFICIENT_BALANCE,
          'Insufficient balance for this transaction.',
          HttpStatus.CONFLICT,
        );
      }

      const data: Prisma.WalletUpdateInput = {
        [field]: after,
        version: { increment: 1 },
      };
      if (input.reason === WalletTxnReason.RECHARGE) {
        data.totalRecharged = { increment: input.amount };
      }
      if (input.reason === WalletTxnReason.GIFT_SEND) {
        data.totalGiftsSentValue = { increment: input.amount };
      }
      if (input.reason === WalletTxnReason.GIFT_RECEIVE) {
        data.totalGiftsReceivedValue = { increment: input.amount };
      }
      if (input.type === WalletEntryType.DEBIT && input.currency === WalletCurrency.GOLD) {
        data.totalSpent = { increment: input.amount };
      }
      await t.wallet.update({ where: { userId: input.userId }, data });

      const transaction = await t.walletTransaction.create({
        data: {
          currency: input.currency,
          amount: input.amount,
          idempotencyKey: input.idempotencyKey,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          metadata: input.metadata,
          createdBy: input.actorId,
          transactionType: 'TRANSFER',
        },
      });

      return t.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          walletId: wallet.id,
          currency: input.currency,
          type: input.type,
          reason: input.reason,
          amount: input.amount,
          balanceBefore: before,
          balanceAfter: after,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          actorId: input.actorId,
        },
      });
    };

    if (tx) {
      return run(tx);
    } else {
      return this.prisma.$transaction(async (t) => run(t));
    }
  }

  async listUserIdsAfter(cursorUserId: string | null, take: number): Promise<string[]> {
    const rows = await this.prisma.wallet.findMany({
      ...(cursorUserId ? { cursor: { userId: cursorUserId }, skip: 1 } : {}),
      take,
      orderBy: { userId: 'asc' },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
}
