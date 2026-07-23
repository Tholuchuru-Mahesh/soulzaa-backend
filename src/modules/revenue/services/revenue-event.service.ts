import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { RevenueDistributionService } from './revenue-distribution.service';

@Injectable()
export class RevenueEventService implements OnModuleInit {
  private readonly logger = new Logger(RevenueEventService.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly distributionService: RevenueDistributionService,
  ) {}

  onModuleInit() {
    // Event-driven subscription to GiftSentEvent
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, async (event) => {
      try {
        await this.handleGiftSent(event.payload);
      } catch (err) {
        this.logger.error(
          `Error handling GiftSentEvent in Revenue Engine: ${(err as Error).message}`,
        );
      }
    });
  }

  /**
   * Processes a GiftSentEvent payload to calculate and distribute host earnings.
   */
  async handleGiftSent(payload: any) {
    const giftTxnId = payload.transactionId;
    const hostId = payload.receiverId; // Receiver in room context is the Host
    const contextType = payload.contextType || 'AUDIO_ROOM';
    const contextId = payload.contextId;
    const totalCoinValue = BigInt(payload.totalCoinValue);

    if (!giftTxnId || !hostId || totalCoinValue <= BigInt(0)) {
      return;
    }

    const result = await this.distributionService.processGiftRevenue({
      giftTxnId,
      hostId,
      contextType,
      contextId,
      totalCoinValue,
    });

    if (result.processed && !result.duplicate) {
      // Publish domain event
      await this.bus.publish({
        name: 'revenue.distributed',
        payload: {
          distributionId: result.distributionId,
          giftTxnId,
          hostId,
          contextType,
          contextId,
          hostEarningsCoins: result.hostEarningsCoins,
          walletTxnId: result.walletTxnId,
        },
      } as any);
    }
  }
}
