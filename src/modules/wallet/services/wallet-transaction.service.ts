import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  TransactionStatus,
  TransactionType,
  WalletCurrency,
  WalletEntryType,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreditWalletDto, DebitWalletDto, TransferWalletDto } from '../dto/create-transaction.dto';
import {
  WalletCreditedEvent,
  WalletDebitedEvent,
  type WalletMovementPayload,
} from '../events/wallet.events';
import { LedgerService } from './ledger.service';
import { WalletAuditService } from './wallet-audit.service';
import { WalletValidationService } from './wallet-validation.service';
import { WalletService } from './wallet.service';

@Injectable()
export class WalletTransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly ledgerService: LedgerService,
    private readonly validationService: WalletValidationService,
    private readonly auditService: WalletAuditService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  /**
   * Publishes the same WALLET_EVENTS.CREDITED/DEBITED events `WalletService.move()`
   * publishes on the Path A (gift/game/etc.) mutation flow, so `WalletRealtimeListener`
   * pushes `transactionCreated`/`transactionCompleted`/`balanceChanged`/`walletUpdated`
   * to the user's sockets everywhere for admin/IAP/reversal/transfer mutations too.
   * Fired only after the DB transaction has committed (unlike Path A, which publishes
   * from inside the still-open transaction) so a rollback can never emit a phantom event.
   */
  private async publishMovement(
    type: WalletEntryType,
    payload: WalletMovementPayload,
  ): Promise<void> {
    const event =
      type === WalletEntryType.CREDIT
        ? new WalletCreditedEvent(payload)
        : new WalletDebitedEvent(payload);
    await this.bus.publish(event);
  }

  /**
   * Two identical requests can both pass the idempotency pre-check above before
   * either commits; the loser then hits the unique constraint (P2002). Instead of
   * leaking a raw Prisma 500, re-fetch the winner's transaction and return it as
   * the idempotent replay — same behaviour as the pre-check, just race-safe.
   */
  private async recoverDuplicate(
    idempotencyKey: string,
    e: unknown,
  ): Promise<ReturnType<WalletTransactionService['formatTransactionResponse']> | null> {
    // Duck-typed P2002 check (not `instanceof PrismaClientKnownRequestError`):
    // works for the real driver error AND for errors serialized across a
    // process boundary, which lose the class identity.
    if ((e as { code?: string })?.code === 'P2002') {
      const existing = await this.prisma.walletTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return this.formatTransactionResponse(existing);
    }
    return null;
  }

  /**
   * Credits a user wallet account with double-entry ledger entry
   */
  async creditWallet(dto: CreditWalletDto, actorId?: string) {
    await this.validationService.validateEconomyStatus();

    const amountBig = BigInt(dto.amount);
    this.validationService.validatePositiveAmount(amountBig);

    // Check idempotency key
    const existingTx = await this.prisma.walletTransaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      include: { ledgerEntries: true },
    });
    if (existingTx) {
      return this.formatTransactionResponse(existingTx);
    }

    const wallet = await this.walletService.getOrCreateWallet(dto.userId);
    this.validationService.validateWalletActive(wallet);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
      // Row-level pessimistic locking
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      const freshWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
      if (!freshWallet) throw new NotFoundException(`Wallet not found`);
      this.validationService.validateWalletActive(freshWallet);

      const balanceBefore = freshWallet.availableBalance;
      const balanceAfter = balanceBefore + amountBig;

      // Create transaction header
      const transaction = await tx.walletTransaction.create({
        data: {
          transactionType: TransactionType.DEPOSIT,
          status: TransactionStatus.COMPLETED,
          destinationWalletId: wallet.id,
          currency: dto.currency ?? WalletCurrency.GOLD,
          amount: amountBig,
          idempotencyKey: dto.idempotencyKey,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          createdBy: actorId,
        },
      });

      // Update wallet balance
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalance:
            dto.currency === WalletCurrency.GOLD ? { increment: amountBig } : undefined,
          goldBalance: dto.currency === WalletCurrency.GOLD ? { increment: amountBig } : undefined,
          gameBalance: dto.currency === WalletCurrency.GAME ? { increment: amountBig } : undefined,
          diamondBalance:
            dto.currency === WalletCurrency.DIAMOND ? { increment: amountBig } : undefined,
          version: { increment: 1 },
        },
      });

      // Append immutable ledger entry
      await this.ledgerService.appendLedgerEntry(tx, {
        transactionId: transaction.id,
        walletId: wallet.id,
        type: WalletEntryType.CREDIT,
        currency: dto.currency ?? WalletCurrency.GOLD,
        reason: dto.reason ?? WalletTxnReason.ADMIN_CREDIT,
        amount: amountBig,
        balanceBefore,
        balanceAfter,
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        description: dto.description ?? 'Wallet Credited',
        actorId,
      });

      await this.auditService.logAudit(
        wallet.id,
        'TRANSACTION_CREATED',
        { transactionId: transaction.id, type: 'CREDIT', amount: amountBig.toString() },
        actorId,
      );

      return {
        transactionId: transaction.id,
        idempotencyKey: transaction.idempotencyKey,
        type: 'CREDIT',
        amount: amountBig.toString(),
        balanceBefore: balanceBefore.toString(),
        balanceAfter: balanceAfter.toString(),
        availableBalance: updatedWallet.availableBalance.toString(),
        status: transaction.status,
        createdAt: transaction.createdAt,
      };
    });

      await this.publishMovement(WalletEntryType.CREDIT, {
        userId: dto.userId,
        transactionId: result.transactionId,
        currency: dto.currency ?? WalletCurrency.GOLD,
        amount: Number(amountBig),
        balanceAfter: Number(result.balanceAfter),
        reason: dto.reason ?? WalletTxnReason.ADMIN_CREDIT,
        referenceType: dto.referenceType ?? null,
        referenceId: dto.referenceId ?? null,
      });

      return result;
    } catch (e) {
      const replay = await this.recoverDuplicate(dto.idempotencyKey, e);
      if (replay) return replay;
      throw e;
    }
  }

  /**
   * Debits a user wallet account with double-entry ledger entry
   */
  async debitWallet(dto: DebitWalletDto, actorId?: string) {
    await this.validationService.validateEconomyStatus();

    const amountBig = BigInt(dto.amount);
    this.validationService.validatePositiveAmount(amountBig);

    // Check idempotency key
    const existingTx = await this.prisma.walletTransaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existingTx) {
      return this.formatTransactionResponse(existingTx);
    }

    const wallet = await this.walletService.getOrCreateWallet(dto.userId);
    this.validationService.validateWalletActive(wallet);
    this.validationService.validateSufficientBalance(wallet, amountBig, dto.currency);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
      // Row-level pessimistic locking
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      const freshWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
      if (!freshWallet) throw new NotFoundException(`Wallet not found`);
      this.validationService.validateWalletActive(freshWallet);
      this.validationService.validateSufficientBalance(freshWallet, amountBig, dto.currency);

      const balanceBefore = freshWallet.availableBalance;
      const balanceAfter = balanceBefore - amountBig;

      // Create transaction header
      const transaction = await tx.walletTransaction.create({
        data: {
          transactionType: TransactionType.WITHDRAWAL,
          status: TransactionStatus.COMPLETED,
          sourceWalletId: wallet.id,
          currency: dto.currency ?? WalletCurrency.GOLD,
          amount: amountBig,
          idempotencyKey: dto.idempotencyKey,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          createdBy: actorId,
        },
      });

      // Update wallet balance
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalance:
            dto.currency === WalletCurrency.GOLD ? { decrement: amountBig } : undefined,
          totalSpent: { increment: amountBig },
          goldBalance: dto.currency === WalletCurrency.GOLD ? { decrement: amountBig } : undefined,
          gameBalance: dto.currency === WalletCurrency.GAME ? { decrement: amountBig } : undefined,
          diamondBalance:
            dto.currency === WalletCurrency.DIAMOND ? { decrement: amountBig } : undefined,
          version: { increment: 1 },
        },
      });

      // Append immutable ledger entry
      await this.ledgerService.appendLedgerEntry(tx, {
        transactionId: transaction.id,
        walletId: wallet.id,
        type: WalletEntryType.DEBIT,
        currency: dto.currency ?? WalletCurrency.GOLD,
        reason: dto.reason ?? WalletTxnReason.ADMIN_DEBIT,
        amount: amountBig,
        balanceBefore,
        balanceAfter,
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        description: dto.description ?? 'Wallet Debited',
        actorId,
      });

      await this.auditService.logAudit(
        wallet.id,
        'TRANSACTION_CREATED',
        { transactionId: transaction.id, type: 'DEBIT', amount: amountBig.toString() },
        actorId,
      );

      return {
        transactionId: transaction.id,
        idempotencyKey: transaction.idempotencyKey,
        type: 'DEBIT',
        amount: amountBig.toString(),
        balanceBefore: balanceBefore.toString(),
        balanceAfter: balanceAfter.toString(),
        availableBalance: updatedWallet.availableBalance.toString(),
        status: transaction.status,
        createdAt: transaction.createdAt,
      };
    });

      await this.publishMovement(WalletEntryType.DEBIT, {
        userId: dto.userId,
        transactionId: result.transactionId,
        currency: dto.currency ?? WalletCurrency.GOLD,
        amount: Number(amountBig),
        balanceAfter: Number(result.balanceAfter),
        reason: dto.reason ?? WalletTxnReason.ADMIN_DEBIT,
        referenceType: dto.referenceType ?? null,
        referenceId: dto.referenceId ?? null,
      });

      return result;
    } catch (e) {
      const replay = await this.recoverDuplicate(dto.idempotencyKey, e);
      if (replay) return replay;
      throw e;
    }
  }

  /**
   * Debits a wallet for a reversal (refunded or charged-back purchase).
   *
   * Deliberately skips two checks that `debitWallet` enforces:
   *
   * - **Sufficient balance.** The coins are usually already spent by the time a
   *   refund lands; refusing would leave refunded coins in circulation. The
   *   balance goes negative and the user cannot spend again until they top up
   *   past zero, which every other debit path already enforces.
   * - **Wallet active.** A suspended wallet is precisely the fraud case a
   *   claw-back targets. Refusing here would make the reversal permanently
   *   un-appliable.
   *
   * Everything else is identical to `debitWallet`: economy-freeze validation,
   * row-level locking, idempotency, and the immutable ledger append.
   *
   * Restricted to the refund path by an explicit reason check below — no
   * other caller can reach the skipped guards, even by accident, because any
   * `dto.reason` other than `PURCHASE_REVERSAL` is rejected before anything
   * is read or mutated.
   */
  async reverseWallet(dto: DebitWalletDto, actorId?: string) {
    if (dto.reason !== WalletTxnReason.PURCHASE_REVERSAL) {
      throw new BadRequestException(
        'reverseWallet is restricted to PURCHASE_REVERSAL; use debitWallet for every other debit',
      );
    }
    // Narrowed to a `const` so the literal type survives capture inside the
    // `$transaction` closure below (TS does not carry parameter narrowing
    // across closure boundaries).
    const reason = dto.reason as WalletTxnReason;

    await this.validationService.validateEconomyStatus();

    const amountBig = BigInt(dto.amount);
    this.validationService.validatePositiveAmount(amountBig);

    const existingTx = await this.prisma.walletTransaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existingTx) {
      return this.formatTransactionResponse(existingTx);
    }

    const wallet = await this.walletService.getOrCreateWallet(dto.userId);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      const freshWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
      if (!freshWallet) throw new NotFoundException(`Wallet not found`);

      const balanceBefore = freshWallet.availableBalance;
      const balanceAfter = balanceBefore - amountBig;

      const transaction = await tx.walletTransaction.create({
        data: {
          transactionType: TransactionType.WITHDRAWAL,
          status: TransactionStatus.COMPLETED,
          sourceWalletId: wallet.id,
          currency: dto.currency ?? WalletCurrency.GOLD,
          amount: amountBig,
          idempotencyKey: dto.idempotencyKey,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          createdBy: actorId,
        },
      });

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalance:
            dto.currency === WalletCurrency.GOLD ? { decrement: amountBig } : undefined,
          totalSpent: { increment: amountBig },
          goldBalance: dto.currency === WalletCurrency.GOLD ? { decrement: amountBig } : undefined,
          gameBalance: dto.currency === WalletCurrency.GAME ? { decrement: amountBig } : undefined,
          diamondBalance:
            dto.currency === WalletCurrency.DIAMOND ? { decrement: amountBig } : undefined,
          version: { increment: 1 },
        },
      });

      await this.ledgerService.appendLedgerEntry(tx, {
        transactionId: transaction.id,
        walletId: wallet.id,
        type: WalletEntryType.DEBIT,
        currency: dto.currency ?? WalletCurrency.GOLD,
        reason,
        amount: amountBig,
        balanceBefore,
        balanceAfter,
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        description: dto.description ?? 'Purchase reversed',
        actorId,
      });

      await this.auditService.logAudit(
        wallet.id,
        'TRANSACTION_CREATED',
        { transactionId: transaction.id, type: 'REVERSAL', amount: amountBig.toString() },
        actorId,
      );

      return {
        transactionId: transaction.id,
        idempotencyKey: transaction.idempotencyKey,
        type: 'DEBIT' as const,
        amount: amountBig.toString(),
        balanceBefore: balanceBefore.toString(),
        balanceAfter: balanceAfter.toString(),
        availableBalance: updatedWallet.availableBalance.toString(),
        status: transaction.status,
        createdAt: transaction.createdAt,
      };
    });

      await this.publishMovement(WalletEntryType.DEBIT, {
        userId: dto.userId,
        transactionId: result.transactionId,
        currency: dto.currency ?? WalletCurrency.GOLD,
        amount: Number(amountBig),
        balanceAfter: Number(result.balanceAfter),
        reason,
        referenceType: dto.referenceType ?? null,
        referenceId: dto.referenceId ?? null,
      });

      return result;
    } catch (e) {
      const replay = await this.recoverDuplicate(dto.idempotencyKey, e);
      if (replay) return replay;
      throw e;
    }
  }

  /**
   * Transfers coins atomically between two wallet accounts with double-entry ledger entries
   */
  async transferCoins(dto: TransferWalletDto, actorId?: string) {
    await this.validationService.validateEconomyStatus();

    const amountBig = BigInt(dto.amount);
    this.validationService.validatePositiveAmount(amountBig);

    const isSelfTransfer = dto.senderUserId === dto.recipientUserId;

    // Check idempotency key
    const existingTx = await this.prisma.walletTransaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existingTx) {
      return this.formatTransactionResponse(existingTx);
    }

    const senderWallet = await this.walletService.getOrCreateWallet(dto.senderUserId);
    const recipientWallet = isSelfTransfer
      ? senderWallet
      : await this.walletService.getOrCreateWallet(dto.recipientUserId);

    this.validationService.validateWalletActive(senderWallet);
    if (!isSelfTransfer) {
      this.validationService.validateWalletActive(recipientWallet);
    }
    this.validationService.validateSufficientBalance(senderWallet, amountBig);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
      if (isSelfTransfer) {
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${senderWallet.id}::uuid FOR UPDATE`;
      } else {
        // Prevent deadlocks by sorting the IDs lexicographically before acquiring row locks
        const [firstId, secondId] = [senderWallet.id, recipientWallet.id].sort();
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${firstId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${secondId}::uuid FOR UPDATE`;
      }

      const freshSender = await tx.wallet.findUnique({ where: { id: senderWallet.id } });
      const freshRecipient = isSelfTransfer
        ? freshSender
        : await tx.wallet.findUnique({ where: { id: recipientWallet.id } });

      if (!freshSender || !freshRecipient) {
        throw new NotFoundException('One or both transfer wallets not found');
      }

      this.validationService.validateWalletActive(freshSender);
      if (!isSelfTransfer) {
        this.validationService.validateWalletActive(freshRecipient);
      }
      this.validationService.validateSufficientBalance(freshSender, amountBig);

      const senderBefore = freshSender.availableBalance;
      const senderAfter = senderBefore - amountBig;

      const recipientBefore = freshRecipient.availableBalance;
      const recipientAfter = isSelfTransfer ? senderAfter : recipientBefore + amountBig;

      // 1. Transaction header
      const transaction = await tx.walletTransaction.create({
        data: {
          transactionType: TransactionType.TRANSFER,
          status: TransactionStatus.COMPLETED,
          sourceWalletId: senderWallet.id,
          destinationWalletId: recipientWallet.id,
          currency: dto.currency ?? WalletCurrency.GOLD,
          amount: amountBig,
          idempotencyKey: dto.idempotencyKey,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          createdBy: actorId,
        },
      });

      // 2. Mutate sender & recipient balances
      const updatedSender = await tx.wallet.update({
        where: { id: senderWallet.id },
        data: {
          availableBalance: { decrement: amountBig },
          totalSpent: { increment: amountBig },
          version: { increment: 1 },
        },
      });

      const updatedRecipient = isSelfTransfer
        ? updatedSender
        : await tx.wallet.update({
            where: { id: recipientWallet.id },
            data: {
              availableBalance: { increment: amountBig },
              version: { increment: 1 },
            },
          });

      // 3. Paired Double-Entry Ledger Records
      // DEBIT on sender
      await this.ledgerService.appendLedgerEntry(tx, {
        transactionId: transaction.id,
        walletId: senderWallet.id,
        type: WalletEntryType.DEBIT,
        currency: dto.currency ?? WalletCurrency.GOLD,
        reason: WalletTxnReason.SYSTEM_TRANSFER,
        amount: amountBig,
        balanceBefore: senderBefore,
        balanceAfter: senderAfter,
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        description: dto.description ?? `Transfer to ${recipientWallet.userId}`,
        actorId,
      });

      // CREDIT on recipient
      await this.ledgerService.appendLedgerEntry(tx, {
        transactionId: transaction.id,
        walletId: recipientWallet.id,
        type: WalletEntryType.CREDIT,
        currency: dto.currency ?? WalletCurrency.GOLD,
        reason: WalletTxnReason.SYSTEM_TRANSFER,
        amount: amountBig,
        balanceBefore: recipientBefore,
        balanceAfter: recipientAfter,
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        description: dto.description ?? `Transfer from ${senderWallet.userId}`,
        actorId,
      });

      await this.auditService.logAudit(
        senderWallet.id,
        'TRANSACTION_CREATED',
        { transactionId: transaction.id, type: 'TRANSFER_OUT', amount: amountBig.toString() },
        actorId,
      );
      await this.auditService.logAudit(
        recipientWallet.id,
        'TRANSACTION_CREATED',
        { transactionId: transaction.id, type: 'TRANSFER_IN', amount: amountBig.toString() },
        actorId,
      );

      return {
        transactionId: transaction.id,
        idempotencyKey: transaction.idempotencyKey,
        type: 'TRANSFER',
        amount: amountBig.toString(),
        senderAvailableBalance: updatedSender.availableBalance.toString(),
        recipientAvailableBalance: updatedRecipient.availableBalance.toString(),
        status: transaction.status,
        createdAt: transaction.createdAt,
      };
    });

      await this.publishMovement(WalletEntryType.DEBIT, {
        userId: dto.senderUserId,
        transactionId: result.transactionId,
        currency: dto.currency ?? WalletCurrency.GOLD,
        amount: Number(amountBig),
        balanceAfter: Number(result.senderAvailableBalance),
        reason: WalletTxnReason.SYSTEM_TRANSFER,
        referenceType: dto.referenceType ?? null,
        referenceId: dto.referenceId ?? null,
      });
      await this.publishMovement(WalletEntryType.CREDIT, {
        userId: dto.recipientUserId,
        transactionId: result.transactionId,
        currency: dto.currency ?? WalletCurrency.GOLD,
        amount: Number(amountBig),
        balanceAfter: Number(result.recipientAvailableBalance),
        reason: WalletTxnReason.SYSTEM_TRANSFER,
        referenceType: dto.referenceType ?? null,
        referenceId: dto.referenceId ?? null,
      });

      return result;
    } catch (e) {
      const replay = await this.recoverDuplicate(dto.idempotencyKey, e);
      if (replay) return replay;
      throw e;
    }
  }

  private formatTransactionResponse(tx: any) {
    return {
      transactionId: tx.id,
      idempotencyKey: tx.idempotencyKey,
      type: tx.transactionType,
      amount: tx.amount.toString(),
      status: tx.status,
      createdAt: tx.createdAt,
      isDuplicateReplay: true,
    };
  }
}
