import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { WalletCurrency, WalletTxnReason, WithdrawalStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { WithdrawalApprovedEvent, WithdrawalRejectedEvent } from '../events/withdrawal.events';
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
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
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

      if (
        [
          WithdrawalStatus.COMPLETED,
          WithdrawalStatus.REJECTED,
          WithdrawalStatus.CANCELLED,
          WithdrawalStatus.FAILED,
        ].includes(req.status as any)
      ) {
        throw new BadRequestException(`Cannot review request in terminal state '${req.status}'`);
      }

      let newStatus: WithdrawalStatus = req.status as any;

      if (action === 'APPROVE') {
        newStatus = WithdrawalStatus.APPROVED;
      } else if (action === 'REJECT') {
        newStatus = WithdrawalStatus.REJECTED;
      } else if (action === 'CANCEL') {
        newStatus = WithdrawalStatus.CANCELLED;
      } else if (action === 'UNDER_REVIEW') {
        newStatus = WithdrawalStatus.UNDER_REVIEW;
      }

      // If REJECTED or CANCELLED, refund reserved funds back to user EARNINGS balance
      if (newStatus === WithdrawalStatus.REJECTED || newStatus === WithdrawalStatus.CANCELLED) {
        await this.walletService.credit({
          userId: req.userId,
          currency: WalletCurrency.DIAMOND,
          amount: Number(req.amountCoins),
          reason: WalletTxnReason.DIAMOND_WITHDRAWAL_REVERSED,
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

      // Published after the status write commits, so a consumer that reads the
      // request back sees the decision rather than racing it. Only the two
      // decisions the user is waiting on are announced — UNDER_REVIEW is an
      // internal step, and CANCELLED is usually the user's own action.
      if (newStatus === 'APPROVED') {
        await this.bus.publish(
          new WithdrawalApprovedEvent({
            withdrawalId: requestId,
            userId: req.userId,
            amount: Number(req.amountCoins),
          }),
        );
      } else if (newStatus === 'REJECTED') {
        await this.bus.publish(
          new WithdrawalRejectedEvent({
            withdrawalId: requestId,
            userId: req.userId,
            amount: Number(req.amountCoins),
            reason,
          }),
        );
      }

      return {
        requestId,
        fromStatus: req.status,
        toStatus: newStatus,
      };
    });
  }
}
