import { Inject, Injectable, Logger } from '@nestjs/common';
import { WalletCurrency } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { WithdrawalAuditService } from './withdrawal-audit.service';
import { WithdrawalStatisticsService } from './withdrawal-statistics.service';
import { WithdrawalValidationService } from './withdrawal-validation.service';

export interface CreateWithdrawalInput {
  userId: string;
  amountCoins: bigint;
  payoutMethod?: string;
  payoutDetails?: Record<string, any>;
}

@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly validationService: WithdrawalValidationService,
    private readonly statisticsService: WithdrawalStatisticsService,
    private readonly auditService: WithdrawalAuditService,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
  ) {}

  /**
   * Submits a new withdrawal request and holds eligible earnings funds under lock.
   */
  async requestWithdrawal(input: CreateWithdrawalInput) {
    const { userId, amountCoins, payoutMethod = 'BANK_TRANSFER', payoutDetails } = input;
    const lockKey = `withdrawal:request:${userId}`;

    return this.locks.withLock(lockKey, async () => {
      // 1. Validate Pre-conditions (Balance, Limits, Freeze, Pending active)
      const { config } = await this.validationService.validateWithdrawalRequest(
        userId,
        amountCoins,
      );

      const fee = BigInt(config.processingFeeCoins);
      const netPayoutAmountCoins = amountCoins > fee ? amountCoins - fee : amountCoins;

      const reqId = `wd-${Date.now()}`;

      // 2. Reserve / Hold funds by debiting EARNINGS currency via IWalletService
      const holdRes = await this.walletService.debit({
        userId,
        currency: WalletCurrency.EARNINGS,
        amount: Number(amountCoins),
        reason: 'WITHDRAWAL' as any,
        idempotencyKey: `withdrawal-hold:${reqId}`,
        referenceType: 'withdrawal_request',
        referenceId: reqId,
      });

      const holdTxnId = holdRes?.transactionId ?? `tx-hold-${Date.now()}`;

      // 3. Create WithdrawalRequest master record
      const request = await this.prisma.withdrawalRequest.create({
        data: {
          id: reqId,
          userId,
          amountCoins,
          processingFeeCoins: fee,
          netPayoutAmountCoins,
          payoutMethod,
          payoutDetails: payoutDetails ? JSON.parse(JSON.stringify(payoutDetails)) : undefined,
          status: 'PENDING',
          holdTxnId,
        },
      });

      // 4. Record State Transition History
      await this.prisma.withdrawalHistory.create({
        data: {
          requestId: request.id,
          userId,
          fromStatus: 'NONE',
          toStatus: 'PENDING',
          actorId: userId,
        },
      });

      // 5. Update Statistics
      await this.statisticsService.updateStatistics(userId, amountCoins, 'REQUESTED');

      // 6. Audit Log
      await this.auditService.logAudit('WITHDRAWAL_REQUESTED', userId, request.id, {
        amountCoins: amountCoins.toString(),
        netPayoutAmountCoins: netPayoutAmountCoins.toString(),
        holdTxnId,
      });

      return {
        requestId: request.id,
        status: request.status,
        amountCoins: request.amountCoins.toString(),
        netPayoutAmountCoins: request.netPayoutAmountCoins.toString(),
        holdTxnId,
      };
    });
  }

  /**
   * Retrieves single withdrawal request details.
   */
  async getWithdrawalRequest(requestId: string) {
    const req = await this.prisma.withdrawalRequest.findUnique({
      where: { id: requestId },
    });

    if (!req) return null;

    return {
      ...req,
      amountCoins: req.amountCoins.toString(),
      processingFeeCoins: req.processingFeeCoins.toString(),
      netPayoutAmountCoins: req.netPayoutAmountCoins.toString(),
    };
  }
}
