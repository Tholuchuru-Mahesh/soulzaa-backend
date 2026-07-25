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

export interface ReviewWithdrawalInput {
  requestId: string;
  reviewerId: string;
  action: 'APPROVE' | 'REJECT' | 'UNDER_REVIEW' | 'CANCEL';
  reason?: string;
}

@Injectable()
export class WithdrawalApprovalService {
  private readonly logger = new Logger(WithdrawalApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly auditService: WithdrawalAuditService,
    private readonly statisticsService: WithdrawalStatisticsService,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
  ) {}

  /**
   * Reviews and transitions withdrawal request status (APPROVE, REJECT, UNDER_REVIEW, CANCEL).
   */
  async reviewWithdrawal(input: ReviewWithdrawalInput) {
    const { requestId, reviewerId, action, reason } = input;
    const lockKey = `withdrawal:review:${requestId}`;

    return this.locks.withLock(lockKey, async () => {
      const req = await this.prisma.withdrawalRequest.findUnique({
        where: { id: requestId },
      });

      if (!req) {
        throw new BadRequestException(`Withdrawal request '${requestId}' not found`);
      }

      if (['COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED'].includes(req.status)) {
        throw new BadRequestException(`Cannot review request in terminal state '${req.status}'`);
      }

      let newStatus = req.status;

      if (action === 'APPROVE') {
        newStatus = 'APPROVED';
      } else if (action === 'REJECT') {
        newStatus = 'REJECTED';
      } else if (action === 'CANCEL') {
        newStatus = 'CANCELLED';
      } else if (action === 'UNDER_REVIEW') {
        newStatus = 'UNDER_REVIEW';
      }

      // If REJECTED or CANCELLED, refund reserved funds back to user EARNINGS balance
      if (newStatus === 'REJECTED' || newStatus === 'CANCELLED') {
        await this.walletService.credit({
          userId: req.userId,
          currency: WalletCurrency.EARNINGS,
          amount: Number(req.amountCoins),
          reason: 'WITHDRAWAL' as any,
          idempotencyKey: `withdrawal-refund:${requestId}`,
          referenceType: 'withdrawal_rejection',
          referenceId: requestId,
        });

        await this.statisticsService.updateStatistics(req.userId, req.amountCoins, 'REJECTED');
      }

      // Update WithdrawalRequest status
      const _updated = await this.prisma.withdrawalRequest.update({
        where: { id: requestId },
        data: { status: newStatus },
      });

      // Insert WithdrawalReview
      await this.prisma.withdrawalReview.create({
        data: {
          requestId,
          reviewerId,
          action,
          reason,
        },
      });

      // Record State History
      await this.prisma.withdrawalHistory.create({
        data: {
          requestId,
          userId: req.userId,
          fromStatus: req.status,
          toStatus: newStatus,
          actorId: reviewerId,
        },
      });

      // Audit Log
      const auditAction =
        newStatus === 'APPROVED'
          ? 'WITHDRAWAL_APPROVED'
          : newStatus === 'REJECTED'
            ? 'WITHDRAWAL_REJECTED'
            : newStatus === 'CANCELLED'
              ? 'WITHDRAWAL_CANCELLED'
              : 'WITHDRAWAL_PROCESSING';

      await this.auditService.logAudit(auditAction, req.userId, requestId, { reason }, reviewerId);

      return {
        requestId,
        fromStatus: req.status,
        toStatus: newStatus,
      };
    });
  }
}
