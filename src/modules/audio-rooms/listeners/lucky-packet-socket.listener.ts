import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  LUCKY_PACKET_EVENTS,
  type LuckyPacketClaimedEvent,
  type LuckyPacketCompletedEvent,
  type LuckyPacketCreatedEvent,
  type LuckyPacketExpiredEvent,
} from 'src/modules/lucky-packets/events/lucky-packet.events';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';

/**
 * Bridges AR-14 lucky-packet events to the audio-room sockets so every
 * participant sees a new packet appear, live claim progress, completion and
 * expiry. Consumes the lucky-packets module only through its published events,
 * keeping the `/audio-room` namespace constant inside the audio-rooms module.
 */
@Injectable()
export class LuckyPacketSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<LuckyPacketCreatedEvent>(LUCKY_PACKET_EVENTS.CREATED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.LUCKY_PACKET_CREATED, e.payload),
    );
    this.bus.subscribe<LuckyPacketClaimedEvent>(LUCKY_PACKET_EVENTS.CLAIMED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.LUCKY_PACKET_CLAIMED, e.payload),
    );
    this.bus.subscribe<LuckyPacketCompletedEvent>(LUCKY_PACKET_EVENTS.COMPLETED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.LUCKY_PACKET_COMPLETED, e.payload),
    );
    this.bus.subscribe<LuckyPacketExpiredEvent>(LUCKY_PACKET_EVENTS.EXPIRED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.LUCKY_PACKET_EXPIRED, e.payload),
    );
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
