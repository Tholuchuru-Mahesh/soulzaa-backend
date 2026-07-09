import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { RankingsService } from '../services/rankings.service';

@Injectable()
export class RankingsActivityListener implements OnModuleInit {
  private readonly logger = new Logger(RankingsActivityListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly rankings: RankingsService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => void this.onGiftSent(e));
  }

  private async onGiftSent(event: GiftSentEvent): Promise<void> {
    const payload = event.payload;
    try {
      await this.rankings.updateGiftRankings({
        senderId: payload.senderId,
        receiverId: payload.receiverId,
        totalCoinValue: payload.totalCoinValue,
        contextType: payload.contextType,
        contextId: payload.contextId,
      });
    } catch (err) {
      this.logger.error(
        `Failed to update rankings for gift transaction ${payload.transactionId}: ${(err as Error).message}`,
      );
    }
  }
}
