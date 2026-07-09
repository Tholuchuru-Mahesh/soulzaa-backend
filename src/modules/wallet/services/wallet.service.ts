import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  WalletCurrency,
  WalletEntryType,
  WalletTransaction,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LockService } from 'src/infra/redis/lock.service';
import { walletLockKey } from '../constants/wallet.constants';
import { WalletCreditedEvent, WalletDebitedEvent } from '../events/wallet.events';
import type {
  IWalletService,
  WalletBalances,
  WalletMovementInput,
  WalletMovementResult,
} from '../interfaces/wallet.service.interface';
import { WalletRepository } from '../repositories/wallet.repository';

/**
 * The economy authority. `debit`/`credit` run under a per-user distributed lock,
 * are idempotent on `idempotencyKey`, apply the balance change + immutable ledger
 * insert in a single DB transaction, guard against negative balances, and publish
 * a domain event. A replayed request returns the original result without
 * re-applying. Other modules consume this only via the WALLET_SERVICE token.
 */
@Injectable()
export class WalletService implements IWalletService {
  constructor(
    private readonly repo: WalletRepository,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async ensureWallet(userId: string): Promise<void> {
    await this.repo.ensureWallet(userId);
  }

  async getBalance(userId: string): Promise<WalletBalances> {
    const wallet = await this.repo.getWallet(userId);
    return {
      gold: Number(wallet?.goldBalance ?? 0n),
      free: Number(wallet?.freeBalance ?? 0n),
      earnings: Number(wallet?.earningsBalance ?? 0n),
    };
  }

  debit(input: WalletMovementInput): Promise<WalletMovementResult> {
    return this.move(WalletEntryType.DEBIT, input);
  }

  credit(input: WalletMovementInput): Promise<WalletMovementResult> {
    return this.move(WalletEntryType.CREDIT, input);
  }

  async listTransactions(
    userId: string,
    q: { skip: number; limit: number; page: number; currency?: WalletCurrency },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listTransactions(userId, q.skip, q.limit, q.currency);
    return buildPaginated(
      rows.map((t) => this.toView(t)),
      total,
      q.page,
      q.limit,
    );
  }

  // ---- Internals ----

  private async move(
    type: WalletEntryType,
    input: WalletMovementInput,
  ): Promise<WalletMovementResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BusinessException(
        ERROR_CODES.INVALID_AMOUNT,
        'Amount must be a positive integer.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.locks.withLock(walletLockKey(input.userId), async () => {
      // Idempotent replay: return the stored result without re-applying.
      const existing = await this.repo.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return {
          transactionId: existing.id,
          currency: existing.currency,
          balanceAfter: Number(existing.balanceAfter),
          duplicate: true,
        };
      }

      const txn = await this.repo.applyMovement({
        userId: input.userId,
        currency: input.currency,
        type,
        reason: input.reason,
        amount: BigInt(input.amount),
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        actorId: input.actorId ?? input.userId,
      });

      await this.publish(type, txn);
      return {
        transactionId: txn.id,
        currency: txn.currency,
        balanceAfter: Number(txn.balanceAfter),
        duplicate: false,
      };
    });
  }

  private async publish(type: WalletEntryType, txn: WalletTransaction): Promise<void> {
    const payload = {
      userId: txn.userId,
      transactionId: txn.id,
      currency: txn.currency,
      amount: Number(txn.amount),
      balanceAfter: Number(txn.balanceAfter),
      reason: txn.reason,
      referenceType: txn.referenceType,
      referenceId: txn.referenceId,
    };
    await this.bus.publish(
      type === WalletEntryType.DEBIT
        ? new WalletDebitedEvent(payload)
        : new WalletCreditedEvent(payload),
    );
  }

  private toView(t: WalletTransaction) {
    return {
      id: t.id,
      currency: t.currency,
      type: t.type,
      reason: t.reason,
      amount: Number(t.amount),
      balanceAfter: Number(t.balanceAfter),
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      createdAt: t.createdAt,
    };
  }

  /** Reason helpers for admin adjustments (keeps the enum out of controllers). */
  static adminReason(type: WalletEntryType): WalletTxnReason {
    return type === WalletEntryType.CREDIT
      ? WalletTxnReason.ADMIN_CREDIT
      : WalletTxnReason.ADMIN_DEBIT;
  }
}
