import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  Wallet,
  WalletCurrency,
  WalletEntryType,
  WalletTransaction,
  WalletTxnReason,
} from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Map a currency to its balance column on the Wallet row. */
const BALANCE_FIELD: Record<WalletCurrency, 'goldBalance' | 'freeBalance' | 'earningsBalance'> = {
  GOLD: 'goldBalance',
  FREE: 'freeBalance',
  EARNINGS: 'earningsBalance',
};

/** Input to atomically apply one balance movement. */
export interface ApplyMovementInput {
  userId: string;
  currency: WalletCurrency;
  type: WalletEntryType;
  reason: WalletTxnReason;
  amount: bigint;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
  metadata: Prisma.InputJsonValue | undefined;
  actorId: string | null;
}

/**
 * Data layer for the wallet: the Wallet row + the append-only wallet_transactions
 * ledger. `applyMovement` performs the read-modify-write and the ledger insert in
 * a single DB transaction so balances and the ledger can never diverge; the
 * service serialises callers per-user with a distributed lock. The negative-
 * balance guard lives here because it must run inside the transaction.
 */
@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  getWallet(userId: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  async ensureWallet(userId: string): Promise<void> {
    await this.prisma.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WalletTransaction | null> {
    return this.prisma.walletTransaction.findUnique({ where: { idempotencyKey } });
  }

  listTransactions(
    userId: string,
    skip: number,
    take: number,
    currency?: WalletCurrency,
  ): Promise<[WalletTransaction[], number]> {
    const where: Prisma.WalletTransactionWhereInput = { userId, ...(currency ? { currency } : {}) };
    return this.prisma.$transaction([
      this.prisma.walletTransaction.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.walletTransaction.count({ where }),
    ]);
  }

  /**
   * Atomically apply a movement: ensure the wallet exists, read the current
   * balance, guard against going negative (debits), update the balance + rolling
   * totals, and insert the immutable ledger row — all in one transaction.
   */
  applyMovement(input: ApplyMovementInput): Promise<WalletTransaction> {
    const field = BALANCE_FIELD[input.currency];
    return this.prisma.$transaction(async (tx) => {
      await tx.wallet.upsert({
        where: { userId: input.userId },
        create: { userId: input.userId },
        update: {},
      });
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: input.userId } });

      const before = wallet[field];
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
      await tx.wallet.update({ where: { userId: input.userId }, data });

      return tx.walletTransaction.create({
        data: {
          userId: input.userId,
          currency: input.currency,
          type: input.type,
          reason: input.reason,
          amount: input.amount,
          balanceBefore: before,
          balanceAfter: after,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          idempotencyKey: input.idempotencyKey,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          createdBy: input.actorId,
        },
      });
    });
  }
}
