import { Injectable } from '@nestjs/common';
import { WalletEntryType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WalletService } from './wallet.service';

export interface WalletBalanceProjection {
  walletId: string;
  userId: string;
  availableBalance: string;
  reservedBalance: string;
  pendingBalance: string;
  lockedBalance: string;
  totalBalance: string;
  gold: number;
  free: number;
  earnings: number;
  currencyBreakdown: {
    gold: number;
    free: number;
    earnings: number;
  };
  version: number;
  updatedAt: Date;
}

@Injectable()
export class BalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Returns complete balance projection for a wallet
   */
  async getBalanceProjection(walletId: string): Promise<WalletBalanceProjection> {
    const wallet = await this.walletService.getWalletById(walletId);

    const goldNum = Number(wallet.goldBalance);
    const freeNum = Number(wallet.freeBalance);
    const earningsNum = Number(wallet.earningsBalance);
    const available = wallet.goldBalance + wallet.freeBalance;
    const total = available + wallet.reservedBalance + wallet.pendingBalance + wallet.lockedBalance;

    return {
      walletId: wallet.id,
      userId: wallet.userId,
      availableBalance: available.toString(),
      reservedBalance: wallet.reservedBalance.toString(),
      pendingBalance: wallet.pendingBalance.toString(),
      lockedBalance: wallet.lockedBalance.toString(),
      totalBalance: total.toString(),
      gold: goldNum,
      free: freeNum,
      earnings: earningsNum,
      currencyBreakdown: {
        gold: goldNum,
        free: freeNum,
        earnings: earningsNum,
      },
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Reconciles current cached wallet balances against immutable ledger entries
   */
  async reconcileBalanceWithLedger(walletId: string) {
    const wallet = await this.walletService.getWalletById(walletId);

    const ledgerEntries = await this.prisma.ledgerEntry.findMany({
      where: { walletId },
    });

    let derivedCreditSum = BigInt(0);
    let derivedDebitSum = BigInt(0);

    for (const entry of ledgerEntries) {
      if (entry.type === WalletEntryType.CREDIT) {
        derivedCreditSum += entry.amount;
      } else if (entry.type === WalletEntryType.DEBIT) {
        derivedDebitSum += entry.amount;
      }
    }

    const derivedNetBalance = derivedCreditSum - derivedDebitSum;
    const currentCachedAvailable = wallet.availableBalance;
    const isReconciled = derivedNetBalance === currentCachedAvailable;

    return {
      walletId,
      cachedAvailableBalance: currentCachedAvailable.toString(),
      derivedNetBalance: derivedNetBalance.toString(),
      derivedCreditSum: derivedCreditSum.toString(),
      derivedDebitSum: derivedDebitSum.toString(),
      isReconciled,
      totalLedgerEntries: ledgerEntries.length,
      reconciledAt: new Date(),
    };
  }
}
