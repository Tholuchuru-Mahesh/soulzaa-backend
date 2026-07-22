import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { GIFT_EVENTS, type GiftRefundedEvent } from 'src/modules/gifts/events/gift.events';
import { VideoRoomPkRepository } from '../repositories/video-room-pk.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPkScoringService } from '../services/video-room-pk-scoring.service';

/**
 * Compensates PK score for a refunded gift (VR-12 spec §6.5).
 *
 * A gift rolled back INSIDE its transaction un-scores itself for free; this
 * listener exists for the other case — a reversal after commit, which needs a
 * compensating negative contribution.
 *
 * Deliberately does NOT unwind a settled battle. Once a battle is COMPLETED the
 * rewards are paid, and retroactively changing the winner would be worse than
 * the inconsistency. Those refunds are logged as an anomaly for an operator and
 * the result stands. Best-effort throughout: a compensation failure must never
 * fail the refund itself.
 *
 * The gifts module's `GiftRefundedPayload` carries only a bare `roomId` — no
 * `contextType` tag identifying which room TYPE issued the refund (today the
 * ONLY emitter is `AudioRoomGiftContextHandler`'s treasure-overflow refund;
 * VIDEO_ROOM's own `onSend` always returns `refundAmount: 0` and can never
 * raise this event). Rather than guess from an absent field, `roomId` is
 * checked against `VideoRoomsRepository` first: a room that isn't a video room
 * at all (every refund on the bus today) is silently ignored, exactly as if it
 * had been filtered by a `contextType` tag. Only once the room is confirmed a
 * video room does the PK battle table get consulted at all — that ordering is
 * what keeps a routine audio-room refund from ever being misreported as a PK
 * anomaly.
 */
@Injectable()
export class VideoRoomPkReversalListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomPkReversalListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prisma: PrismaService,
    private readonly rooms: VideoRoomsRepository,
    private readonly pkRepo: VideoRoomPkRepository,
    private readonly pkScoring: VideoRoomPkScoringService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftRefundedEvent>(GIFT_EVENTS.REFUNDED, (e) => this.handle(e.payload));
  }

  private async handle(payload: GiftRefundedEvent['payload']): Promise<void> {
    try {
      const room = await this.rooms.findById(payload.roomId);
      if (!room) return; // not a video room — e.g. today's only emitter, AUDIO_ROOM

      await this.prisma.$transaction(async (tx) => {
        const battle = await this.pkRepo.findCurrent(payload.roomId, tx);
        if (!battle) {
          // Spec §6.5: no non-terminal battle to compensate — either the room
          // never ran one, or it already COMPLETED and its rewards are paid.
          // Rewriting a settled winner would be worse than leaving this stand,
          // so this is logged as an anomaly for an operator, not auto-fixed.
          this.logger.warn(
            `PK reversal skipped: no non-terminal battle for room ${payload.roomId} ` +
              `(refund txn ${payload.transactionId})`,
          );
          return;
        }

        await this.pkScoring.reverse(tx, {
          roomId: payload.roomId,
          senderId: payload.senderId,
          // The refund payload names no receiver; `reverse` looks up the
          // original contribution rows by (battleId, giftTxnId) and never
          // reads `receiverIds`, so this is a harmless placeholder.
          receiverIds: [],
          totalCoinValue: payload.totalRefundAmount,
          giftTxnId: payload.transactionId,
        });
      });
    } catch (err) {
      this.logger.warn(
        `PK reversal failed for refund ${payload.transactionId}: ${(err as Error).message}`,
      );
    }
  }
}
