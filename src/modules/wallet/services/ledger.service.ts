import { Injectable } from '@nestjs/common';
import { WalletCurrency, WalletEntryType, WalletTxnReason } from '@prisma/client';

export interface CreateLedgerParams {
  transactionId: string;
  walletId: string;
  type: WalletEntryType;
  currency: WalletCurrency;
  reason: WalletTxnReason;
  amount: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  actorId?: string;
}

@Injectable()
export class LedgerService {
  /**
   * Appends an immutable double-entry ledger record inside an active Prisma transaction
   */
  async appendLedgerEntry(txPrisma: any, params: CreateLedgerParams) {
    return txPrisma.ledgerEntry.create({
      data: {
        transactionId: params.transactionId,
        walletId: params.walletId,
        type: params.type,
        currency: params.currency,
        reason: params.reason,
        amount: params.amount,
        balanceBefore: params.balanceBefore,
        balanceAfter: params.balanceAfter,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        description: params.description,
        actorId: params.actorId,
      },
    });
  }
}
