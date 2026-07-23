import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { WalletCurrency } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { WithdrawalAuditService } from './withdrawal-audit.service';
import { WithdrawalStatisticsService } from './withdrawal-statistics.service';

export interface ExecutePayoutInput {
  requestId: string;
  payoutTxnId?: string;
}

@Injectable()
export class WithdrawalExecutionService {
  private readonly logger = new Logger(WithdrawalExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly auditService: WithdrawalAuditService,
    private readonly statisticsService: WithdrawalStatisticsService,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
  ) {}

  /**
   * Executes payout for an APPROVED withdrawal request.
   */
  async executePayout(input: ExecutePayoutInput) {
    const { requestId } = input;
    const lockKey = `withdrawal:exec:${requestId}`;

    return this.locks.withLock(lockKey, async () => {
      const req = await this.prisma.withdrawalRequest.findUnique({
        where: { id: requestId },
      });

      if (!req) {
        throw new BadRequestException(`Withdrawal request '${requestId}' not found`);
      }

      if (req.status !== 'APPROVED' && req.status !== 'PROCESSING') {
        throw new BadRequestException(
          `Request must be APPROVED to execute payout (current: '${req.status}')`,
        );
      }

      // Transition to PROCESSING
      await this.prisma.withdrawalRequest.update({
        where: { id: requestId },
        data: { status: 'PROCESSING' },
      });

      await this.prisma.withdrawalHistory.create({
        data: {
          requestId,
          userId: req.userId,
          fromStatus: req.status,
          toStatus: 'PROCESSING',
        },
      });

      await this.auditService.logAudit('WITHDRAWAL_PROCESSING', req.userId, requestId);

      const payoutTxnId = input.payoutTxnId ?? `payout-tx-${Date.now()}`;

      try {
        // Funds were already debited at request time. Mark as COMPLETED.
        await this.prisma.withdrawalRequest.update({
          where: { id: requestId },
          data: {
            status: 'COMPLETED',
            payoutTxnId,
          },
        });

        await this.prisma.withdrawalHistory.create({
          data: {
            requestId,
            userId: req.userId,
            fromStatus: 'PROCESSING',
            toStatus: 'COMPLETED',
          },
        });

        // Update Statistics
        await this.statisticsService.updateStatistics(req.userId, req.amountCoins, 'COMPLETED');

        // Audit Log
        await this.auditService.logAudit('WITHDRAWAL_COMPLETED', req.userId, requestId, {
          payoutTxnId,
          netPayoutAmountCoins: req.netPayoutAmountCoins.toString(),
        });

        return {
          requestId,
          status: 'COMPLETED',
          payoutTxnId,
        };
      } catch (err) {
        this.logger.error(
          `Payout execution failed for withdrawal '${requestId}': ${(err as Error).message}`,
        );

        // Refund reserved funds on failure
        await this.walletService.credit({
          userId: req.userId,
          currency: WalletCurrency.EARNINGS,
          amount: Number(req.amountCoins),
          reason: 'WITHDRAWAL' as any,
          idempotencyKey: `withdrawal-failure-refund:${requestId}`,
          referenceType: 'withdrawal_failure',
          referenceId: requestId,
        });

        await this.prisma.withdrawalRequest.update({
          where: { id: requestId },
          data: { status: 'FAILED' },
        });

        await this.prisma.withdrawalFailure.create({
          data: {
            requestId,
            errorCode: 'PAYOUT_EXECUTION_FAILED',
            errorMessage: (err as Error).message,
          },
        });

        await this.prisma.withdrawalHistory.create({
          data: {
            requestId,
            userId: req.userId,
            fromStatus: 'PROCESSING',
            toStatus: 'FAILED',
          },
        });

        await this.auditService.logAudit('WITHDRAWAL_FAILED', req.userId, requestId, {
          error: (err as Error).message,
        });

        return {
          requestId,
          status: 'FAILED',
          error: (err as Error).message,
        };
      }
    });
  }
}
