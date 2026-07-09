import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { PkBattleService } from '../services/pk-battle.service';

/**
 * Feeds gift value into an active PK battle. Subscribes to the gifts module's
 * GiftSentEvent and, for AUDIO_ROOM gifts, adds the gift's gold value to the
 * receiver's PK side score (a no-op when the receiver is not a battle
 * participant). Best-effort — a failure never affects the gift.
 */
@Injectable()
export class PkGiftListener implements OnModuleInit {
  private readonly logger = new Logger(PkGiftListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly pk: PkBattleService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => {
      if (e.payload.contextType !== GiftContextType.AUDIO_ROOM) return;
      void this.pk
        .handleGift(
          e.payload.contextId,
          e.payload.receiverId,
          e.payload.totalCoinValue,
          e.payload.transactionId,
        )
        .catch((err) =>
          this.logger.warn(
            `PK gift scoring failed for ${e.payload.transactionId}: ${(err as Error).message}`,
          ),
        );
    });
  }
}
