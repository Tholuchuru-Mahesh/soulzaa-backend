import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  GIFT_EVENTS,
  type GiftComboEvent,
  type GiftLuckyWinEvent,
  type GiftSentEvent,
} from 'src/modules/gifts/events/gift.events';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import { VIDEO_ROOM_GIFT_SOCKET_EVENTS } from '../constants/video-room-gift.constants';
import {
  VIDEO_ROOM_GIFT_EVENTS,
  type VideoRoomGiftAnimationEvent,
  type VideoRoomGiftComboEndedEvent,
  type VideoRoomGiftComboStartedEvent,
  type VideoRoomGiftComboUpdatedEvent,
  type VideoRoomGiftDeliveredEvent,
  type VideoRoomGiftFailedEvent,
  type VideoRoomGiftQueueUpdatedEvent,
  type VideoRoomGiftRecoveredEvent,
} from '../events/video-room-gift.events';

import { VideoRoomGiftStatisticsService } from '../services/video-room-gift-statistics.service';

/**
 * Bridges gift events to the `/video-room` sockets (VR-10). Follows the module's
 * established pattern: no domain gateway — inbound is the shared BaseGateway,
 * outbound is EVENT_BUS relayed here.
 *
 * Shared gifts-module events (`gift.sent`, `gift.combo`, `gift.lucky_win`) are
 * consumed and filtered on `contextType === VIDEO_ROOM`, exactly as the audio
 * bridge filters AUDIO_ROOM. Without that filter every audio-room gift would
 * also broadcast into video rooms.
 */
@Injectable()
export class VideoRoomGiftSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    @Optional() private readonly statistics?: VideoRoomGiftStatisticsService,
  ) {}

  onModuleInit(): void {
    // ---- Reused gifts-module events, filtered to this context ----
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, async (e) => {
      if (!this.isVideoRoom(e.payload.contextType)) return;
      this.toRoom(e.payload.contextId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_SENT, e.payload);
      // The receiver is told wherever they are, so a gift lands even if they
      // have navigated away from the room.
      this.sockets.emitToUserEverywhere(
        e.payload.receiverId,
        VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_SENT,
        e.payload,
      );

      if (this.statistics) {
        try {
          await this.statistics.record(e.payload.contextId, [
            {
              id: e.payload.transactionId,
              senderId: e.payload.senderId,
              receiverId: e.payload.receiverId,
              giftId: e.payload.giftId,
              giftType: (e.payload as any).giftType ?? 'CLASSIC',
              contextType: GiftContextType.VIDEO_ROOM,
              contextId: e.payload.contextId,
              quantity: e.payload.quantity ?? 1,
              comboTier: e.payload.comboTier ?? 1,
              totalCoinValue: BigInt(e.payload.totalCoinValue),
              creatorEarnings: BigInt(e.payload.creatorEarnings),
              appliedEarningsPct: 50,
              cashbackAmount: 0n,
              appliedCashbackPct: 0,
              isLuckyWin: (e.payload as any).isLuckyWin ?? false,
              luckyMultiplier: (e.payload as any).luckyMultiplier ?? 1,
              status: 'COMPLETED',
              createdAt: new Date(),
              updatedAt: new Date(),
              metadata: {
                giftName: (e.payload as any).giftName ?? '',
                batchId: (e.payload as any).batchId ?? e.payload.transactionId,
              },
            } as any,
          ]);
        } catch {
          // non-fatal
        }
      }
    });

    this.bus.subscribe<GiftComboEvent>(GIFT_EVENTS.COMBO, (e) => {
      if (!this.isVideoRoom(e.payload.contextType)) return;
      this.toRoom(e.payload.contextId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_COMBO_UPDATED, e.payload);
    });

    this.bus.subscribe<GiftLuckyWinEvent>(GIFT_EVENTS.LUCKY_WIN, (e) => {
      if (!this.isVideoRoom(e.payload.contextType)) return;
      this.toRoom(e.payload.contextId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_ANIMATION, e.payload);
    });

    // ---- Video-room-owned events (already scoped to this context) ----
    this.bus.subscribe<VideoRoomGiftAnimationEvent>(VIDEO_ROOM_GIFT_EVENTS.ANIMATION, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_ANIMATION, e.payload);
    });

    this.bus.subscribe<VideoRoomGiftDeliveredEvent>(VIDEO_ROOM_GIFT_EVENTS.DELIVERED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_DELIVERED, e.payload);
      this.sockets.emitToUserEverywhere(
        e.payload.receiverId,
        VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_DELIVERED,
        e.payload,
      );
    });

    this.bus.subscribe<VideoRoomGiftFailedEvent>(VIDEO_ROOM_GIFT_EVENTS.FAILED, (e) => {
      // Failures go to the sender only — other viewers never saw the animation,
      // so telling the room a gift failed would surface a non-event.
      this.sockets.emitToUserEverywhere(
        e.payload.senderId,
        VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_FAILED,
        e.payload,
      );
    });

    this.bus.subscribe<VideoRoomGiftRecoveredEvent>(VIDEO_ROOM_GIFT_EVENTS.RECOVERED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_RECOVERED, e.payload);
    });

    this.bus.subscribe<VideoRoomGiftQueueUpdatedEvent>(
      VIDEO_ROOM_GIFT_EVENTS.QUEUE_UPDATED,
      (e) => {
        this.toRoom(e.payload.roomId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_QUEUE_UPDATED, e.payload);
      },
    );

    this.bus.subscribe<VideoRoomGiftComboStartedEvent>(
      VIDEO_ROOM_GIFT_EVENTS.COMBO_STARTED,
      (e) => {
        this.toRoom(e.payload.roomId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_COMBO_STARTED, e.payload);
      },
    );

    this.bus.subscribe<VideoRoomGiftComboUpdatedEvent>(
      VIDEO_ROOM_GIFT_EVENTS.COMBO_UPDATED,
      (e) => {
        this.toRoom(e.payload.roomId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_COMBO_UPDATED, e.payload);
      },
    );

    this.bus.subscribe<VideoRoomGiftComboEndedEvent>(VIDEO_ROOM_GIFT_EVENTS.COMBO_ENDED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_GIFT_SOCKET_EVENTS.GIFT_COMBO_ENDED, e.payload);
    });
  }

  private isVideoRoom(contextType: GiftContextType): boolean {
    return contextType === GiftContextType.VIDEO_ROOM;
  }

  private toRoom(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
