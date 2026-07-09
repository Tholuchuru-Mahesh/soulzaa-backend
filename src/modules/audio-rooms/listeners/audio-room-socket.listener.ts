import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';
import {
  AUDIO_ROOM_EVENTS,
  type RoomCreatedEvent,
  type RoomDeletedEvent,
  type RoomEndedEvent,
  type RoomJoinedEvent,
  type RoomLeftEvent,
  type RoomLockedEvent,
  type RoomOwnershipTransferredEvent,
  type RoomUpdatedEvent,
} from '../events/audio-room.events';
import {
  AUDIO_ROOM_SEAT_EVENTS,
  type SeatAcceptedEvent,
  type SeatJoinedEvent,
  type SeatLeftEvent,
  type SeatLockedEvent,
  type SeatRejectedEvent,
  type SeatRequestedEvent,
  type SeatUnlockedEvent,
  type SeatUpdatedEvent,
} from '../events/audio-room-seat.events';

/**
 * Bridges audio-room domain events on the EVENT_BUS to realtime `room.*`
 * broadcasts into the `/audio-room` Socket.IO namespace room, cross-instance via
 * the Redis adapter. Keeps the module free of a direct gateway dependency —
 * mirrors the session module's socket listener. The infra AudioRoomGateway stays
 * a thin transport shell; all domain fan-out flows through here.
 */
@Injectable()
export class AudioRoomSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomCreatedEvent>(AUDIO_ROOM_EVENTS.CREATED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.CREATED, e.payload),
    );
    this.bus.subscribe<RoomUpdatedEvent>(AUDIO_ROOM_EVENTS.UPDATED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.UPDATED, e.payload),
    );
    this.bus.subscribe<RoomDeletedEvent>(AUDIO_ROOM_EVENTS.DELETED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.DELETED, e.payload),
    );
    this.bus.subscribe<RoomEndedEvent>(AUDIO_ROOM_EVENTS.ENDED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.CLOSED, e.payload),
    );
    this.bus.subscribe<RoomJoinedEvent>(AUDIO_ROOM_EVENTS.JOINED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.JOINED, e.payload),
    );
    this.bus.subscribe<RoomLeftEvent>(AUDIO_ROOM_EVENTS.LEFT, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.LEFT, e.payload),
    );
    this.bus.subscribe<RoomLockedEvent>(AUDIO_ROOM_EVENTS.LOCKED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.LOCKED, e.payload),
    );
    this.bus.subscribe<RoomOwnershipTransferredEvent>(
      AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED,
      (e) => this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.OWNERSHIP_TRANSFERRED, e.payload),
    );

    // ---- Seats (AR-1) ----
    this.bus.subscribe<SeatRequestedEvent>(AUDIO_ROOM_SEAT_EVENTS.REQUESTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_REQUESTED, e.payload),
    );
    this.bus.subscribe<SeatAcceptedEvent>(AUDIO_ROOM_SEAT_EVENTS.ACCEPTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_ACCEPTED, e.payload),
    );
    this.bus.subscribe<SeatRejectedEvent>(AUDIO_ROOM_SEAT_EVENTS.REJECTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_REJECTED, e.payload),
    );
    this.bus.subscribe<SeatLockedEvent>(AUDIO_ROOM_SEAT_EVENTS.LOCKED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_LOCKED, e.payload),
    );
    this.bus.subscribe<SeatUnlockedEvent>(AUDIO_ROOM_SEAT_EVENTS.UNLOCKED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_UNLOCKED, e.payload),
    );
    this.bus.subscribe<SeatJoinedEvent>(AUDIO_ROOM_SEAT_EVENTS.JOINED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_JOINED, e.payload),
    );
    this.bus.subscribe<SeatLeftEvent>(AUDIO_ROOM_SEAT_EVENTS.LEFT, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_LEFT, e.payload),
    );
    this.bus.subscribe<SeatUpdatedEvent>(AUDIO_ROOM_SEAT_EVENTS.UPDATED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.SEAT_UPDATED, e.payload),
    );
  }

  private emit(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
