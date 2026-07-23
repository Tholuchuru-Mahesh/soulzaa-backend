import { Inject, Injectable, Logger } from '@nestjs/common';
import { WalletCurrency } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { HostEarningsService } from './host-earnings.service';
import { RevenueAuditService } from './revenue-audit.service';
import { RevenueCalculationService } from './revenue-calculation.service';
import { RevenueStatisticsService } from './revenue-statistics.service';
import { RevenueValidationService } from './revenue-validation.service';

export interface ProcessRevenueInput {
  giftTxnId: string;
  hostId: string;
  contextType: string;
  contextId: string;
  totalCoinValue: bigint;
}

@Injectable()
export class RevenueDistributionService {
  private readonly logger = new Logger(RevenueDistributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly validationService: RevenueValidationService,
    private readonly calculationService: RevenueCalculationService,
    private readonly hostEarningsService: HostEarningsService,
    private readonly statisticsService: RevenueStatisticsService,
    private readonly auditService: RevenueAuditService,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
  ) {}

  /**
   * Processes a gift transaction to calculate and distribute host earnings safely under lock.
   */
  async processGiftRevenue(input: ProcessRevenueInput) {
    const { giftTxnId, hostId, contextType, contextId, totalCoinValue } = input;

    if (totalCoinValue <= BigInt(0)) {
      return {
        processed: false,
        duplicate: false,
        distributionId: null,
        hostEarningsCoins: '0',
        walletTxnId: null,
        reason: 'ZERO_COIN_VALUE',
      };
    }

    const lockKey = `revenue:dist:${giftTxnId}`;

    return this.locks.withLock(lockKey, async () => {
      // 1. Validation & Idempotency / Replay protection check
      const val = await this.validationService.validateRevenueDistribution(giftTxnId, hostId);
      if (val.isDuplicate && val.existingDistribution) {
        this.logger.log(`Revenue distribution replay for giftTxnId ${giftTxnId}`);
        return {
          processed: true,
          duplicate: true,
          distributionId: val.existingDistribution.id,
          hostEarningsCoins: val.existingDistribution.hostEarningsCoins.toString(),
        };
      }

      // 2. Calculate dynamic split
      const split = await this.calculationService.calculateSplit(totalCoinValue);

      await this.auditService.logAudit('REVENUE_CALCULATED', hostId, {
        giftTxnId,
        totalCoinValue: totalCoinValue.toString(),
        hostEarningsCoins: split.hostEarningsCoins.toString(),
        hostPercentage: split.hostPercentage,
      });

      // 3. Credit host wallet via IWalletService (WalletTransactionService double-entry ledger)
      const walletRes = await this.walletService.credit({
        userId: hostId,
        currency: WalletCurrency.EARNINGS,
        amount: Number(split.hostEarningsCoins),
        reason: 'HOST_EARNING' as any,
        idempotencyKey: `host-earning:${giftTxnId}`,
        referenceType: 'gift_transaction',
        referenceId: giftTxnId,
        metadata: { contextType, contextId },
      });

      const walletTxnId = walletRes?.transactionId ?? `tx-rev-${Date.now()}`;

      // 4. Create immutable RevenueDistribution record
      const distribution = await this.prisma.revenueDistribution.create({
        data: {
          giftTxnId,
          contextType,
          contextId,
          hostId,
          totalCoinValue,
          hostPercentage: split.hostPercentage,
          platformPercentage: split.platformPercentage,
          hostEarningsCoins: split.hostEarningsCoins,
          platformEarningsCoins: split.platformEarningsCoins,
          walletTxnId,
        },
      });

      // 5. Create RevenueHistory record
      await this.prisma.revenueHistory.create({
        data: {
          hostId,
          contextId,
          amount: split.hostEarningsCoins,
          sourceType: 'GIFT',
        },
      });

      // 6. Update HostEarnings accumulator & pre-aggregated Statistics
      await this.hostEarningsService.incrementHostEarnings(hostId, split.hostEarningsCoins);
      await this.statisticsService.updateStatistics(hostId, contextId, split.hostEarningsCoins);

      // 7. Audit log
      await this.auditService.logAudit('HOST_EARNING_CREDITED', hostId, {
        distributionId: distribution.id,
        giftTxnId,
        hostEarningsCoins: split.hostEarningsCoins.toString(),
        walletTxnId,
      });

      return {
        processed: true,
        duplicate: false,
        distributionId: distribution.id,
        hostEarningsCoins: split.hostEarningsCoins.toString(),
        walletTxnId,
      };
    });
  }
}
