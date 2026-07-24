import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { RevenueDistributionService } from './revenue-distribution.service';

@Injectable()
export class RevenueEventService implements OnModuleInit {
  private readonly logger = new Logger(RevenueEventService.name);

  /**
   * Contexts whose gift receiver is a host/creator earning via the configurable
   * revenue split. Direct/DM/profile contexts (e.g. PRIVATE_CHAT) pay the
   * receiver through the gift handler instead — revenue must NOT also fire for
   * them, otherwise the receiver is paid twice.
   */
  private static readonly HOST_CONTEXTS = new Set<string>([
    'AUDIO_ROOM',
    'VIDEO_ROOM',
    'LIVE_STREAM',
    'PK_BATTLE',
    'MULTI_HOST_BATTLE',
  ]);

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
    const hostId = payload.receiverId; // Receiver in a host context is the earner
    const contextType = payload.contextType; // no default — see gate below
    const contextId = payload.contextId;
    const totalCoinValue = BigInt(payload.totalCoinValue);

    if (!giftTxnId || !hostId || totalCoinValue <= BigInt(0)) {
      return;
    }

    // Split by context: only host contexts pay the receiver via the revenue
    // split. Direct/DM/profile gifts are paid by the gift handler directly.
    if (!contextType || !RevenueEventService.HOST_CONTEXTS.has(contextType)) {
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
