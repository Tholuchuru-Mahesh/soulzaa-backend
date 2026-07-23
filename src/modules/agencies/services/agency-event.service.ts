import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { AgencySettlementService } from './agency-settlement.service';

@Injectable()
export class AgencyEventService implements OnModuleInit {
  private readonly logger = new Logger(AgencyEventService.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly settlementService: AgencySettlementService,
  ) {}

  onModuleInit() {
    // Event-driven subscription to RevenueDistributedEvent
    this.bus.subscribe<any>('revenue.distributed', async (event) => {
      try {
        await this.handleRevenueDistributed(event.payload);
      } catch (err) {
        this.logger.error(
          `Error handling RevenueDistributedEvent in Agency Engine: ${(err as Error).message}`,
        );
      }
    });
  }

  /**
   * Processes a RevenueDistributedEvent payload to calculate and distribute agency commissions.
   */
  async handleRevenueDistributed(payload: any) {
    const revenueDistributionId = payload.distributionId;
    const giftTxnId = payload.giftTxnId;
    const hostId = payload.hostId;
    const hostEarningsCoins = BigInt(payload.hostEarningsCoins || 0);

    if (!revenueDistributionId || !hostId || hostEarningsCoins <= BigInt(0)) {
      return;
    }

    const result = await this.settlementService.processRevenueSettlement({
      revenueDistributionId,
      giftTxnId,
      hostId,
      hostEarningsCoins,
    });

    if (result.processed && !result.duplicate) {
      // Publish domain event
      await this.bus.publish({
        name: 'agency.settlement_completed',
        payload: {
          revenueDistributionId,
          giftTxnId,
          agencyId: result.agencyId,
          hostId,
          agencyCommissionCoins: result.agencyCommissionCoins,
          walletTxnId: result.walletTxnId,
        },
      } as any);
    }
  }
}
