import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { PROFILE_SERVICE, type IProfileService } from '../interfaces/profile.interface';

/**
 * Keeps the denormalised gift counters on `user_statistics` in sync with
 * each completed gift transaction.
 *
 * On `gift.sent`:
 *   - receiver's `giftsReceived` += quantity
 *   - receiver's `coinsReceived` += totalCoinValue
 *   - sender's   `giftsSent`    += quantity
 *
 * These three counters are exposed on the public profile card (the "Gifts
 * Recv" stat shown to other users). Without this listener the columns stay
 * at their initial value of 0, so the profile page always shows 0 gifts.
 */
@Injectable()
export class GiftStatisticsListener implements OnModuleInit {
  private readonly logger = new Logger(GiftStatisticsListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => void this.onGiftSent(e));
  }

  private async onGiftSent(event: GiftSentEvent): Promise<void> {
    const { senderId, receiverId, quantity, totalCoinValue } = event.payload;
    try {
      await Promise.all([
        // Receiver counters
        this.profile.incrementStatistic(receiverId, 'giftsReceived', quantity),
        this.profile.incrementStatistic(receiverId, 'coinsReceived', totalCoinValue),
        // Sender counter
        this.profile.incrementStatistic(senderId, 'giftsSent', quantity),
      ]);

      // Emit realtime updates cross-namespace so mobile profile & gift showcase sheets auto-refresh
      this.sockets.emitToUserEverywhere(receiverId, 'user.gifts_updated', event.payload);
      this.sockets.emitToUserEverywhere(receiverId, 'profile:updated', { userId: receiverId });
      this.sockets.emitToUserEverywhere(senderId, 'profile:updated', { userId: senderId });
    } catch (err) {
      // Non-fatal — log and continue; a failed counter update must not block
      // the gift transaction which has already been committed.
      this.logger.error(
        `Failed to update gift statistics for sender=${senderId} receiver=${receiverId}: ${(err as Error).message}`,
      );
    }
  }
}
