import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CoinSellerSettlementService } from './coin-seller-settlement.service';

@Injectable()
export class CoinSellerEventService implements OnModuleInit {
  private readonly logger = new Logger(CoinSellerEventService.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly settlementService: CoinSellerSettlementService,
  ) {}

  onModuleInit() {
    // Event-driven subscription to payment/purchase completion events
    this.bus.subscribe<any>('payment.completed', async (event) => {
      try {
        await this.handlePurchaseCompleted(event.payload);
      } catch (err) {
        this.logger.error(
          `Error handling payment.completed in Coin Seller Engine: ${(err as Error).message}`,
        );
      }
    });

    this.bus.subscribe<any>('coin_purchase.completed', async (event) => {
      try {
        await this.handlePurchaseCompleted(event.payload);
      } catch (err) {
        this.logger.error(
          `Error handling coin_purchase.completed in Coin Seller Engine: ${(err as Error).message}`,
        );
      }
    });
  }

  /**
   * Processes a coin purchase completion payload to calculate and distribute seller commissions.
   */
  async handlePurchaseCompleted(payload: any) {
    const purchaseTxnId = payload.transactionId || payload.purchaseId || payload.id;
    const buyerId = payload.userId || payload.buyerId;
    const purchaseAmountCoins = BigInt(payload.coins || payload.coinAmount || payload.amount || 0);

    if (!purchaseTxnId || !buyerId || purchaseAmountCoins <= BigInt(0)) {
      return;
    }

    const result = await this.settlementService.processPurchaseSettlement({
      purchaseTxnId,
      buyerId,
      purchaseAmountCoins,
    });

    if (result.processed && !result.duplicate) {
      // Publish domain event
      await this.bus.publish({
        name: 'coin_seller.settlement_completed',
        payload: {
          purchaseTxnId,
          sellerId: result.sellerId,
          buyerId,
          sellerCommissionCoins: result.sellerCommissionCoins,
          walletTxnId: result.walletTxnId,
        },
      } as any);
    }
  }
}
