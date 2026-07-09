import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';
import {
  AUDIO_ROOM_PREMIUM_EVENTS,
  type PremiumSeatEndedEvent,
  type PremiumSeatGrantedEvent,
  type WatchPartyUpdatedEvent,
} from '../events/audio-room-premium.events';

/**
 * Bridges AR-9 premium events to the audio-room sockets: premium-admin seat
 * grants/expiries broadcast to the room (and to the affected user cross-room so
 * their client updates privileges), and watch-party state changes broadcast so
 * every client stays in sync.
 */
@Injectable()
export class PremiumSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PremiumSeatGrantedEvent>(
      AUDIO_ROOM_PREMIUM_EVENTS.PREMIUM_SEAT_GRANTED,
      (e) => {
        this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.PREMIUM_SEAT_GRANTED, e.payload);
        this.sockets.emitToUserEverywhere(
          e.payload.userId,
          ROOM_SOCKET_EVENTS.PREMIUM_SEAT_GRANTED,
          e.payload,
        );
      },
    );
    this.bus.subscribe<PremiumSeatEndedEvent>(AUDIO_ROOM_PREMIUM_EVENTS.PREMIUM_SEAT_ENDED, (e) => {
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.PREMIUM_SEAT_ENDED, e.payload);
      this.sockets.emitToUserEverywhere(
        e.payload.userId,
        ROOM_SOCKET_EVENTS.PREMIUM_SEAT_ENDED,
        e.payload,
      );
    });
    this.bus.subscribe<WatchPartyUpdatedEvent>(AUDIO_ROOM_PREMIUM_EVENTS.WATCH_PARTY_UPDATED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.WATCH_PARTY, e.payload),
    );
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
