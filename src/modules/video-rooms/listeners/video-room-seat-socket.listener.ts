import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatInvitationResolvedEvent,
  type SeatInvitationSentEvent,
  type SeatLeftEvent,
  type SeatLockedEvent,
  type SeatReleasedEvent,
  type SeatRequestResolvedEvent,
  type SeatRequestedEvent,
  type SeatReservedEvent,
  type SeatSwitchedEvent,
  type SeatSyncEvent,
  type SeatTakenEvent,
  type SeatTransferredEvent,
  type SeatUnlockedEvent,
  type SeatUpdatedEvent,
} from '../events/video-room-seat.events';

/**
 * Bridges VR-4 seat domain events on the EVENT_BUS to realtime `video_room.seat_*`
 * broadcasts into the `/video-room` namespace room (cross-instance via the Redis
 * adapter). Mirrors `VideoRoomSocketListener`; seat services never touch sockets.
 * Occupancy changes (taken/left) surface as the coalesced `seat_updated`; request
 * and invitation resolutions branch to approved/rejected + accepted/rejected.
 */
@Injectable()
export class VideoRoomSeatSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SeatTakenEvent>(VIDEO_ROOM_SEAT_EVENTS.TAKEN, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_UPDATED, e.payload),
    );
    this.bus.subscribe<SeatLeftEvent>(VIDEO_ROOM_SEAT_EVENTS.LEFT, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_UPDATED, e.payload),
    );
    this.bus.subscribe<SeatUpdatedEvent>(VIDEO_ROOM_SEAT_EVENTS.UPDATED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_UPDATED, e.payload),
    );
    this.bus.subscribe<SeatLockedEvent>(VIDEO_ROOM_SEAT_EVENTS.LOCKED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_LOCKED, e.payload),
    );
    this.bus.subscribe<SeatUnlockedEvent>(VIDEO_ROOM_SEAT_EVENTS.UNLOCKED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_UNLOCKED, e.payload),
    );
    this.bus.subscribe<SeatReservedEvent>(VIDEO_ROOM_SEAT_EVENTS.RESERVED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_RESERVED, e.payload),
    );
    this.bus.subscribe<SeatReleasedEvent>(VIDEO_ROOM_SEAT_EVENTS.RELEASED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_RELEASED, e.payload),
    );
    this.bus.subscribe<SeatRequestedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUESTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUESTED, e.payload),
    );
    this.bus.subscribe<SeatRequestResolvedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, (e) =>
      this.emit(
        e.payload.roomId,
        e.payload.status === 'ACCEPTED'
          ? VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED
          : VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED,
        e.payload,
      ),
    );
    this.bus.subscribe<SeatInvitationSentEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_SENT, e.payload),
    );
    this.bus.subscribe<SeatInvitationResolvedEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED,
      (e) =>
        this.emit(
          e.payload.roomId,
          e.payload.status === 'ACCEPTED'
            ? VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_ACCEPTED
            : VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED,
          e.payload,
        ),
    );
    this.bus.subscribe<SeatSwitchedEvent>(VIDEO_ROOM_SEAT_EVENTS.SWITCHED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_SWITCHED, e.payload),
    );
    this.bus.subscribe<SeatTransferredEvent>(VIDEO_ROOM_SEAT_EVENTS.TRANSFERRED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_TRANSFERRED, e.payload),
    );
    this.bus.subscribe<SeatSyncEvent>(VIDEO_ROOM_SEAT_EVENTS.SYNC, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_SYNC, e.payload),
    );
  }

  private emit(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
