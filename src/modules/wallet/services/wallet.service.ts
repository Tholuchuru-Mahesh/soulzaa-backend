import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  LedgerEntry,
  Prisma,
  WalletCurrency,
  WalletEntryType,
  WalletStatus,
  WalletType,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { buildPaginated } from 'src/common/utils/pagination.util';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { walletLockKey } from '../constants/wallet.constants';
import {
  IWalletService,
  WalletBalances,
  WalletMovementInput,
  WalletMovementResult,
} from '../interfaces/wallet.service.interface';
import { WalletMetrics } from '../metrics/wallet.metrics';
import { WalletRepository } from '../repositories/wallet.repository';
import { WalletCreditedEvent, WalletDebitedEvent } from '../events/wallet.events';
import { WalletAuditService } from './wallet-audit.service';
import { WalletValidationService } from './wallet-validation.service';

@Injectable()
export class WalletService implements IWalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: WalletRepository,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: WalletMetrics,
    private readonly auditService: WalletAuditService,
    private readonly validationService: WalletValidationService,
  ) {}

  /**
   * Retrieves or creates a Wallet account for a target user
   */
  async getOrCreateWallet(userId: string, type: WalletType = WalletType.USER_WALLET) {
    let wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: {
          userId,
          type,
          status: WalletStatus.ACTIVE,
          availableBalance: BigInt(0),
          goldBalance: BigInt(0),
          diamondBalance: BigInt(0),
          gameBalance: BigInt(0),
          freeBalance: BigInt(0),
          earningsBalance: BigInt(0),
        },
      });

      await this.auditService.logAudit(wallet.id, 'WALLET_CREATED', { userId, type });
    }

    return wallet;
  }

  async ensureWallet(userId: string): Promise<void> {
    await this.repo.ensureWallet(userId);
  }

  async getBalance(userId: string): Promise<WalletBalances> {
    const wallet = await this.repo.getWallet(userId);
    return {
      gold: Number(wallet?.goldBalance ?? 0n),
      diamond: Number(wallet?.diamondBalance ?? 0n),
      game: Number(wallet?.gameBalance ?? 0n),
    };
  }

  debit(input: WalletMovementInput, tx?: Prisma.TransactionClient): Promise<WalletMovementResult> {
    return this.move(WalletEntryType.DEBIT, input, tx);
  }

  credit(input: WalletMovementInput, tx?: Prisma.TransactionClient): Promise<WalletMovementResult> {
    return this.move(WalletEntryType.CREDIT, input, tx);
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
    tx?: Prisma.TransactionClient,
  ): Promise<WalletMovementResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BusinessException(
        ERROR_CODES.INVALID_AMOUNT,
        'Amount must be a positive integer.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Emergency-economy freeze + wallet feature flag. Validated on DEBIT only:
    // an emergency freeze must halt money leaving the economy (bets, gifts,
    // game stakes, VIP), while credits (payouts/refunds/settlements) still
    // flow so nothing gets stuck mid-settlement for the duration of the freeze.
    if (type === WalletEntryType.DEBIT) {
      await this.validationService.validateEconomyStatus();
    }

    const run = async (t?: Prisma.TransactionClient) => {
      // Idempotent replay: return the stored result without re-applying. The
      // reported `balanceAfter` is the wallet's CURRENT balance for the
      // currency (not the original movement amount), so a replayed tap shows
      // the balance the user actually holds right now.
      const existing = await this.repo.findByIdempotencyKey(input.idempotencyKey, t);
      if (existing) {
        const wallet = await this.repo.getWallet(input.userId);
        const balanceField =
          input.currency === WalletCurrency.GOLD
            ? 'goldBalance'
            : input.currency === WalletCurrency.DIAMOND
              ? 'diamondBalance'
              : input.currency === WalletCurrency.GAME
                ? 'gameBalance'
                : input.currency === WalletCurrency.FREE
                  ? 'freeBalance'
                  : 'earningsBalance';
        const balance = wallet?.[balanceField as keyof typeof wallet] ?? 0n;
        return {
          transactionId: existing.id,
          currency: existing.currency,
          balanceAfter: Number(balance),
          duplicate: true,
        };
      }

      const entry = await this.repo.applyMovement(
        {
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
        },
        t,
      );

      await this.publish(type, entry);
      return {
        transactionId: entry.transactionId,
        currency: entry.currency,
        balanceAfter: Number(entry.balanceAfter),
        duplicate: false,
      };
    };

    if (tx) {
      return run(tx);
    } else {
      return this.locks.withLock(walletLockKey(input.userId), async () => {
        return run();
      });
    }
  }

  private async publish(type: WalletEntryType, entry: LedgerEntry): Promise<void> {
    this.metrics.recordMovement(entry.reason, type, entry.currency, 0);
    const wallet = await this.prisma.wallet.findUnique({ where: { id: entry.walletId } });
    const event =
      type === WalletEntryType.CREDIT
        ? new WalletCreditedEvent({
            transactionId: entry.transactionId,
            userId: wallet?.userId ?? '',
            currency: entry.currency,
            amount: Number(entry.amount),
            reason: entry.reason,
            balanceAfter: Number(entry.balanceAfter),
            referenceType: entry.referenceType ?? null,
            referenceId: entry.referenceId ?? null,
          })
        : new WalletDebitedEvent({
            transactionId: entry.transactionId,
            userId: wallet?.userId ?? '',
            currency: entry.currency,
            amount: Number(entry.amount),
            reason: entry.reason,
            balanceAfter: Number(entry.balanceAfter),
            referenceType: entry.referenceType ?? null,
            referenceId: entry.referenceId ?? null,
          });
    await this.bus.publish(event);
  }

  private toView(t: LedgerEntry) {
    return {
      id: t.id,
      transactionId: t.transactionId,
      walletId: t.walletId,
      currency: t.currency,
      type: t.type,
      reason: t.reason,
      amount: Number(t.amount),
      balanceBefore: Number(t.balanceBefore),
      balanceAfter: Number(t.balanceAfter),
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      createdAt: t.createdAt,
    };
  }

  /**
   * Get wallet by ID
   */
  async getWalletById(walletId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet '${walletId}' not found`);
    }

    return wallet;
  }

  /**
   * Get wallet by User ID
   */
  async getWalletByUserId(userId: string) {
    return this.getOrCreateWallet(userId);
  }

  /**
   * Updates wallet operational status (e.g. ACTIVE, LOCKED, FROZEN, SUSPENDED)
   */
  async updateWalletStatus(walletId: string, status: WalletStatus, actorId?: string) {
    const wallet = await this.getWalletById(walletId);

    const updated = await this.prisma.wallet.update({
      where: { id: walletId },
      data: { status },
    });

    const action = status === WalletStatus.LOCKED ? 'WALLET_LOCKED' : 'STATUS_UPDATED';
    await this.auditService.logAudit(
      wallet.id,
      action,
      { previousStatus: wallet.status, newStatus: status },
      actorId,
    );

    return updated;
  }
}
