import { Inject, Injectable, Logger } from '@nestjs/common';
import { WalletCurrency } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { AgencyAuditService } from './agency-audit.service';
import { AgencyCommissionService } from './agency-commission.service';
import { AgencyStatisticsService } from './agency-statistics.service';
import { AgencyValidationService } from './agency-validation.service';

export interface ProcessSettlementInput {
  revenueDistributionId: string;
  giftTxnId: string;
  hostId: string;
  hostEarningsCoins: bigint;
}

@Injectable()
export class AgencySettlementService {
  private readonly logger = new Logger(AgencySettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly validationService: AgencyValidationService,
    private readonly commissionService: AgencyCommissionService,
    private readonly statisticsService: AgencyStatisticsService,
    private readonly auditService: AgencyAuditService,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
  ) {}

  /**
   * Processes agency commission settlement for a host revenue distribution safely under lock.
   */
  async processRevenueSettlement(input: ProcessSettlementInput) {
    const { revenueDistributionId, giftTxnId, hostId, hostEarningsCoins } = input;

    if (hostEarningsCoins <= BigInt(0)) {
      return {
        processed: false,
        duplicate: false,
        agencyId: null,
        agencyCommissionCoins: '0',
        walletTxnId: null,
        reason: 'ZERO_HOST_EARNINGS',
      };
    }

    const lockKey = `agency:settlement:${revenueDistributionId}`;

    return this.locks.withLock(lockKey, async () => {
      // 1. Validate & Check idempotency / relationship
      const val = await this.validationService.validateSettlement(revenueDistributionId, hostId);

      if (val.isDuplicate && val.existingSettlement) {
        this.logger.log(
          `Agency settlement replay for revenueDistributionId ${revenueDistributionId}`,
        );
        return {
          processed: true,
          duplicate: true,
          agencyId: val.existingSettlement.agencyId,
          agencyCommissionCoins: val.existingSettlement.agencyCommissionCoins.toString(),
          walletTxnId: val.existingSettlement.walletTxnId,
        };
      }

      if (!val.relationship) {
        this.logger.log(`Host ${hostId} is unassigned to an active agency. Skipping settlement.`);
        return {
          processed: false,
          duplicate: false,
          agencyId: null,
          agencyCommissionCoins: '0',
          walletTxnId: null,
          reason: 'INDEPENDENT_HOST_NO_AGENCY',
        };
      }

      const agencyId = val.relationship.agencyId;

      // 2. Calculate dynamic commission
      const comm = await this.commissionService.calculateCommission(hostEarningsCoins);

      await this.auditService.logAudit('AGENCY_COMMISSION_CALCULATED', agencyId, hostId, {
        revenueDistributionId,
        hostEarningsCoins: hostEarningsCoins.toString(),
        commissionPercentage: comm.commissionPercentage,
        agencyCommissionCoins: comm.agencyCommissionCoins.toString(),
      });

      if (comm.agencyCommissionCoins <= BigInt(0)) {
        return {
          processed: false,
          duplicate: false,
          agencyId,
          agencyCommissionCoins: '0',
          walletTxnId: null,
          reason: 'COMMISSION_ZERO',
        };
      }

      // 3. Credit agency wallet via IWalletService (WalletTransactionService double-entry ledger)
      const walletRes = await this.walletService.credit({
        userId: agencyId,
        currency: WalletCurrency.EARNINGS,
        amount: Number(comm.agencyCommissionCoins),
        reason: 'AGENCY_COMMISSION' as any,
        idempotencyKey: `agency-comm:${revenueDistributionId}`,
        referenceType: 'revenue_distribution',
        referenceId: revenueDistributionId,
        metadata: { hostId, giftTxnId },
      });

      const walletTxnId = walletRes?.transactionId ?? `tx-agcomm-${Date.now()}`;

      // 4. Create immutable AgencySettlement master record
      const settlement = await this.prisma.agencySettlement.create({
        data: {
          revenueDistributionId,
          giftTxnId,
          agencyId,
          hostId,
          hostEarningsCoins,
          commissionPercentage: comm.commissionPercentage,
          agencyCommissionCoins: comm.agencyCommissionCoins,
          walletTxnId,
          status: 'COMPLETED',
        },
      });

      // 5. Create AgencyCommission and AgencyHistory records
      await this.prisma.agencyCommission.create({
        data: {
          settlementId: settlement.id,
          agencyId,
          hostId,
          amount: comm.agencyCommissionCoins,
        },
      });

      await this.prisma.agencyHistory.create({
        data: {
          agencyId,
          hostId,
          amount: comm.agencyCommissionCoins,
          sourceType: 'HOST_REVENUE',
        },
      });

      // 6. Update pre-aggregated Statistics
      await this.statisticsService.updateStatistics(agencyId, comm.agencyCommissionCoins);

      // 7. Audit log
      await this.auditService.logAudit('AGENCY_COMMISSION_CREDITED', agencyId, hostId, {
        settlementId: settlement.id,
        revenueDistributionId,
        agencyCommissionCoins: comm.agencyCommissionCoins.toString(),
        walletTxnId,
      });

      return {
        processed: true,
        duplicate: false,
        agencyId,
        agencyCommissionCoins: comm.agencyCommissionCoins.toString(),
        walletTxnId,
      };
    });
  }
}
