import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';
import {
  AUDIO_ROOM_PK_EVENTS,
  type PkCancelledEvent,
  type PkEndedEvent,
  type PkScoreEvent,
  type PkStartedEvent,
  type PkInvitedEvent,
  type PkRejectedEvent,
} from '../events/audio-room-pk.events';

/**
 * Bridges AR-10 PK-battle events to the audio-room sockets so every participant
 * sees the battle start (with the roster + timer), live score ticks on each
 * contribution, and the result/winner animation. Consumes only published events.
 */
@Injectable()
export class PkSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PkStartedEvent>(AUDIO_ROOM_PK_EVENTS.STARTED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.PK_STARTED, e.payload),
    );
    this.bus.subscribe<PkScoreEvent>(AUDIO_ROOM_PK_EVENTS.SCORE, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.PK_SCORE, e.payload),
    );
    this.bus.subscribe<PkEndedEvent>(AUDIO_ROOM_PK_EVENTS.ENDED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.PK_ENDED, e.payload),
    );
    this.bus.subscribe<PkCancelledEvent>(AUDIO_ROOM_PK_EVENTS.CANCELLED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.PK_CANCELLED, e.payload),
    );
    this.bus.subscribe<PkInvitedEvent>(AUDIO_ROOM_PK_EVENTS.INVITED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.PK_INVITED, e.payload),
    );
    this.bus.subscribe<PkRejectedEvent>(AUDIO_ROOM_PK_EVENTS.REJECTED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.PK_REJECTED, e.payload),
    );
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
