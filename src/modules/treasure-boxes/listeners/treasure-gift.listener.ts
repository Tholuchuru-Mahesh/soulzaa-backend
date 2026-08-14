import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { RocketService } from '../services/rocket.service';
import { TreasureEventService } from '../services/treasure-event.service';

/**
 * Feeds gift value into treasure boxes and rocket events. Subscribes to the
 * gifts module's GiftSentEvent (the cross-module seam) and, for AUDIO_ROOM and
 * VIDEO_ROOM gifts, contributes to the room's active treasure box and to any
 * rocket the gift triggers.
 */
@Injectable()
export class TreasureGiftListener implements OnModuleInit {
  private readonly logger = new Logger(TreasureGiftListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly treasureEvents: TreasureEventService,
    private readonly rocket: RocketService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => {
      if (
        e.payload.contextType !== GiftContextType.AUDIO_ROOM &&
        e.payload.contextType !== GiftContextType.VIDEO_ROOM
      ) {
        return;
      }
      void this.handle(e);
    });
  }

  private async handle(e: GiftSentEvent): Promise<void> {
    const p = e.payload;

    // 1. Apply gift progress to active Treasure Box
    try {
      await this.treasureEvents.handleGiftSent(p);
    } catch (err) {
      this.logger.error(
        `Treasure box progress processing failed for gift ${p.transactionId}: ${(err as Error).message}`,
      );
    }

    // 2. Apply gift contribution to active Rocket event if applicable
    try {
      await this.rocket.maybeTrigger({
        roomId: p.contextId,
        giftId: p.giftId,
        senderId: p.senderId,
        giftValue: p.totalCoinValue,
        giftTxnId: p.transactionId,
      });
    } catch (err) {
      this.logger.warn(
        `Rocket trigger failed for gift ${p.transactionId}: ${(err as Error).message}`,
      );
    }
  }
}
