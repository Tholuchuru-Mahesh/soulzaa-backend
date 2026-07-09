import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  GIFT_EVENTS,
  type GiftComboEvent,
  type GiftLuckyWinEvent,
  type GiftSentEvent,
} from 'src/modules/gifts/events/gift.events';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';

/**
 * Bridges AR-5 gift events to the audio-room sockets. When a gift is sent in an
 * AUDIO_ROOM context, the full gift (animation/sound metadata, combo tier, lucky
 * win, sender/receiver) is broadcast to the room so every participant plays the
 * animation, and the receiver is additionally notified cross-room. Gifts in other
 * contexts (video/live/chat) are handled by those modules' own bridges. This
 * keeps the `/audio-room` namespace constant inside the audio-rooms module while
 * consuming the gifts module only through its published events.
 */
@Injectable()
export class GiftSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => {
      if (e.payload.contextType !== GiftContextType.AUDIO_ROOM) return;
      this.room(e.payload.contextId, ROOM_SOCKET_EVENTS.GIFT_SENT, e.payload);
      this.sockets.emitToUserEverywhere(
        e.payload.receiverId,
        ROOM_SOCKET_EVENTS.GIFT_RECEIVED,
        e.payload,
      );
    });
    this.bus.subscribe<GiftComboEvent>(GIFT_EVENTS.COMBO, (e) => {
      if (e.payload.contextType !== GiftContextType.AUDIO_ROOM) return;
      this.room(e.payload.contextId, ROOM_SOCKET_EVENTS.GIFT_COMBO, e.payload);
    });
    this.bus.subscribe<GiftLuckyWinEvent>(GIFT_EVENTS.LUCKY_WIN, (e) => {
      if (e.payload.contextType !== GiftContextType.AUDIO_ROOM) return;
      this.room(e.payload.contextId, ROOM_SOCKET_EVENTS.GIFT_LUCKY, e.payload);
    });
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
