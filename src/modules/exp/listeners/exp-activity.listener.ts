import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { ExpSource } from 'src/common/enums/exp-source.enum';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  AUDIO_ROOM_EVENTS,
  type RoomJoinedEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { ROOM_JOIN_EXP } from '../constants/exp.limits';
import { ExpService } from '../services/exp.service';

/**
 * Accrues EXP from platform activity. Consumes the gifts module's GiftSentEvent
 * (sender + receiver EXP already computed in the payload, plus room EXP) and the
 * audio-rooms RoomJoinedEvent (a daily-capped join award). Best-effort — a
 * failure here never affects the source action. Other EXP sources (daily login,
 * tasks, games) award via EXP_SERVICE directly from their own modules.
 */
@Injectable()
export class ExpActivityListener implements OnModuleInit {
  private readonly logger = new Logger(ExpActivityListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly exp: ExpService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => void this.onGift(e));
    this.bus.subscribe<RoomJoinedEvent>(AUDIO_ROOM_EVENTS.JOINED, (e) => void this.onJoin(e));
  }

  private async onGift(e: GiftSentEvent): Promise<void> {
    const p = e.payload;
    try {
      if (p.senderExp > 0) {
        await this.exp.award({
          userId: p.senderId,
          amount: p.senderExp,
          source: ExpSource.GIFT_SENT,
          idempotencyKey: `gift-sent:${p.transactionId}`,
          referenceType: 'gift',
          referenceId: p.transactionId,
        });
      }
      // A self-gift pays the SENDER leg only. Self-gifting is a supported flow,
      // but crediting both legs to one user would make it worth
      // (senderRate + receiverRate) per coin while gifting anyone else pays the
      // sender rate alone — making self-dealing the cheapest route to a level.
      // Paying just the sender leg keeps every gift worth the same to its sender.
      if (p.receiverExp > 0 && p.receiverId !== p.senderId) {
        await this.exp.award({
          userId: p.receiverId,
          amount: p.receiverExp,
          source: ExpSource.GIFT_RECEIVED,
          idempotencyKey: `gift-recv:${p.transactionId}`,
          referenceType: 'gift',
          referenceId: p.transactionId,
        });
      }
      if (p.contextType === GiftContextType.AUDIO_ROOM && p.senderExp > 0) {
        await this.exp.awardRoom({
          roomId: p.contextId,
          amount: p.senderExp,
          source: ExpSource.GIFT_SENT,
          idempotencyKey: `gift-room:${p.transactionId}`,
          referenceId: p.transactionId,
        });
      }
    } catch (err) {
      this.logger.warn(`EXP award for gift ${p.transactionId} failed: ${(err as Error).message}`);
    }
  }

  private async onJoin(e: RoomJoinedEvent): Promise<void> {
    const { roomId, userId } = e.payload;
    // Daily-capped: at most one ROOM_JOIN award per user/room/day.
    const day = new Date().toISOString().slice(0, 10);
    try {
      await this.exp.award({
        userId,
        amount: ROOM_JOIN_EXP,
        source: ExpSource.ROOM_JOIN,
        idempotencyKey: `join:${roomId}:${userId}:${day}`,
        referenceType: 'room',
        referenceId: roomId,
      });
    } catch (err) {
      this.logger.warn(`EXP award for room join failed: ${(err as Error).message}`);
    }
  }
}
