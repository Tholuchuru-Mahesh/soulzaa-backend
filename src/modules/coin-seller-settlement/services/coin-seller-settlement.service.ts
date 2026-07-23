import { Inject, Injectable, Logger } from '@nestjs/common';
import { WalletCurrency } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { CoinSellerAuditService } from './coin-seller-audit.service';
import { CoinSellerCommissionService } from './coin-seller-commission.service';
import { CoinSellerStatisticsService } from './coin-seller-statistics.service';
import { CoinSellerValidationService } from './coin-seller-validation.service';

export interface ProcessPurchaseSettlementInput {
  purchaseTxnId: string;
  buyerId: string;
  purchaseAmountCoins: bigint;
}

@Injectable()
export class CoinSellerSettlementService {
  private readonly logger = new Logger(CoinSellerSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly validationService: CoinSellerValidationService,
    private readonly commissionService: CoinSellerCommissionService,
    private readonly statisticsService: CoinSellerStatisticsService,
    private readonly auditService: CoinSellerAuditService,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
  ) {}

  /**
   * Processes coin seller commission settlement for a completed purchase transaction under lock.
   */
  async processPurchaseSettlement(input: ProcessPurchaseSettlementInput) {
    const { purchaseTxnId, buyerId, purchaseAmountCoins } = input;

    if (purchaseAmountCoins <= BigInt(0)) {
      return {
        processed: false,
        duplicate: false,
        sellerId: null,
        sellerCommissionCoins: '0',
        walletTxnId: null,
        reason: 'ZERO_PURCHASE_COINS',
      };
    }

    const lockKey = `seller:settlement:${purchaseTxnId}`;

    return this.locks.withLock(lockKey, async () => {
      // 1. Validate & Check idempotency / relationship
      const val = await this.validationService.validateSettlement(purchaseTxnId, buyerId);

      if (val.isDuplicate && val.existingSettlement) {
        this.logger.log(`Coin seller settlement replay for purchaseTxnId ${purchaseTxnId}`);
        return {
          processed: true,
          duplicate: true,
          sellerId: val.existingSettlement.sellerId,
          sellerCommissionCoins: val.existingSettlement.sellerCommissionCoins.toString(),
          walletTxnId: val.existingSettlement.walletTxnId,
        };
      }

      if (!val.relationship) {
        this.logger.log(
          `Buyer ${buyerId} is not mapped to an active coin seller. Skipping settlement.`,
        );
        return {
          processed: false,
          duplicate: false,
          sellerId: null,
          sellerCommissionCoins: '0',
          walletTxnId: null,
          reason: 'INDEPENDENT_BUYER_NO_SELLER',
        };
      }

      const sellerId = val.relationship.sellerId;

      // 2. Calculate dynamic commission
      const comm = await this.commissionService.calculateCommission(purchaseAmountCoins);

      await this.auditService.logAudit('COIN_SELLER_COMMISSION_CALCULATED', sellerId, buyerId, {
        purchaseTxnId,
        purchaseAmountCoins: purchaseAmountCoins.toString(),
        commissionPercentage: comm.commissionPercentage,
        sellerCommissionCoins: comm.sellerCommissionCoins.toString(),
      });

      if (comm.sellerCommissionCoins <= BigInt(0)) {
        return {
          processed: false,
          duplicate: false,
          sellerId,
          sellerCommissionCoins: '0',
          walletTxnId: null,
          reason: 'COMMISSION_ZERO',
        };
      }

      // 3. Credit seller wallet via IWalletService (WalletTransactionService double-entry ledger)
      const walletRes = await this.walletService.credit({
        userId: sellerId,
        currency: WalletCurrency.EARNINGS,
        amount: Number(comm.sellerCommissionCoins),
        reason: 'COIN_SELLER_COMMISSION' as any,
        idempotencyKey: `seller-comm:${purchaseTxnId}`,
        referenceType: 'coin_purchase',
        referenceId: purchaseTxnId,
        metadata: { buyerId },
      });

      const walletTxnId = walletRes?.transactionId ?? `tx-sellcomm-${Date.now()}`;

      // 4. Create immutable CoinSellerSettlement master record
      const settlement = await this.prisma.coinSellerSettlement.create({
        data: {
          purchaseTxnId,
          sellerId,
          buyerId,
          purchaseAmountCoins,
          commissionPercentage: comm.commissionPercentage,
          sellerCommissionCoins: comm.sellerCommissionCoins,
          walletTxnId,
          status: 'COMPLETED',
        },
      });

      // 5. Create CoinSellerCommission and CoinSellerHistory records
      await this.prisma.coinSellerCommission.create({
        data: {
          settlementId: settlement.id,
          sellerId,
          buyerId,
          amount: comm.sellerCommissionCoins,
        },
      });

      await this.prisma.coinSellerHistory.create({
        data: {
          sellerId,
          buyerId,
          amount: comm.sellerCommissionCoins,
          sourceType: 'COIN_PURCHASE',
        },
      });

      // 6. Update pre-aggregated Statistics
      await this.statisticsService.updateStatistics(sellerId, comm.sellerCommissionCoins);

      // 7. Audit log
      await this.auditService.logAudit('COIN_SELLER_COMMISSION_CREDITED', sellerId, buyerId, {
        settlementId: settlement.id,
        purchaseTxnId,
        sellerCommissionCoins: comm.sellerCommissionCoins.toString(),
        walletTxnId,
      });

      return {
        processed: true,
        duplicate: false,
        sellerId,
        sellerCommissionCoins: comm.sellerCommissionCoins.toString(),
        walletTxnId,
      };
    });
  }
}
