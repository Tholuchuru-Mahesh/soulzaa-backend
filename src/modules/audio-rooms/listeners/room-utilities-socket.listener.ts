import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  ROOM_UTIL_EVENTS,
  type CoinFlippedEvent,
  type CountdownCancelledEvent,
  type CountdownCompletedEvent,
  type CountdownPausedEvent,
  type CountdownResumedEvent,
  type CountdownStartedEvent,
  type CountdownTickEvent,
  type DiceRolledEvent,
  type PollCreatedEvent,
  type PollEndedEvent,
  type PollVotedEvent,
  type RandomPickedEvent,
  type SpinResultEvent,
} from 'src/modules/room-utilities/events/room-utilities.events';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';

/**
 * Bridges AR-15 interactive-utility events to the audio-room sockets so every
 * participant sees polls, dice, coin flips, random picks, spins and countdowns
 * in realtime. Consumes the room-utilities module only through its published
 * events, keeping the `/audio-room` namespace constant inside audio-rooms.
 */
@Injectable()
export class RoomUtilitiesSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PollCreatedEvent>(ROOM_UTIL_EVENTS.POLL_CREATED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.POLL_CREATED, e.payload),
    );
    this.bus.subscribe<PollVotedEvent>(ROOM_UTIL_EVENTS.POLL_VOTED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.POLL_VOTED, e.payload),
    );
    this.bus.subscribe<PollEndedEvent>(ROOM_UTIL_EVENTS.POLL_ENDED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.POLL_ENDED, e.payload),
    );
    this.bus.subscribe<DiceRolledEvent>(ROOM_UTIL_EVENTS.DICE_ROLLED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.DICE_ROLLED, e.payload),
    );
    this.bus.subscribe<CoinFlippedEvent>(ROOM_UTIL_EVENTS.COIN_FLIPPED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.COIN_FLIPPED, e.payload),
    );
    this.bus.subscribe<RandomPickedEvent>(ROOM_UTIL_EVENTS.RANDOM_PICKED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.RANDOM_PICKED, e.payload),
    );
    this.bus.subscribe<SpinResultEvent>(ROOM_UTIL_EVENTS.SPIN_RESULT, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.SPIN_RESULT, e.payload),
    );
    this.bus.subscribe<CountdownStartedEvent>(ROOM_UTIL_EVENTS.COUNTDOWN_STARTED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.COUNTDOWN_STARTED, e.payload),
    );
    this.bus.subscribe<CountdownTickEvent>(ROOM_UTIL_EVENTS.COUNTDOWN_TICK, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.COUNTDOWN_TICK, e.payload),
    );
    this.bus.subscribe<CountdownPausedEvent>(ROOM_UTIL_EVENTS.COUNTDOWN_PAUSED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.COUNTDOWN_PAUSED, e.payload),
    );
    this.bus.subscribe<CountdownResumedEvent>(ROOM_UTIL_EVENTS.COUNTDOWN_RESUMED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.COUNTDOWN_RESUMED, e.payload),
    );
    this.bus.subscribe<CountdownCompletedEvent>(ROOM_UTIL_EVENTS.COUNTDOWN_COMPLETED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.COUNTDOWN_COMPLETED, e.payload),
    );
    this.bus.subscribe<CountdownCancelledEvent>(ROOM_UTIL_EVENTS.COUNTDOWN_CANCELLED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.COUNTDOWN_CANCELLED, e.payload),
    );
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
