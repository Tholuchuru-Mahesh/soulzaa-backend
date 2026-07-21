import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_SEAT_EVENTS,
  type SeatInvitationDeliveredEvent,
  type SeatInvitationExpiredEvent,
  type SeatInvitationResolvedEvent,
  type SeatInvitationResolution,
  type SeatInvitationSentEvent,
  type SeatLeftEvent,
  type SeatLockedEvent,
  type SeatQueueUpdatedEvent,
  type SeatReleasedEvent,
  type SeatRequestExpiredEvent,
  type SeatRequestResolvedEvent,
  type SeatRequestResolution,
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
 * Request resolution → outbound socket event.
 *
 * Declared exhaustively rather than as a ternary: the previous
 * `status === 'ACCEPTED' ? approved : rejected` shape announced CANCELLED and
 * EXPIRED resolutions to the whole room as `seat_rejected`, and would have done
 * the same to VR-8's PROMOTED. An unmapped status emits nothing at all, which is
 * always safer than emitting the wrong thing.
 */
const REQUEST_RESOLUTION_EVENTS: Partial<Record<SeatRequestResolution, string>> = {
  ACCEPTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED,
  PROMOTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_APPROVED,
  REJECTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_REJECTED,
  // FAILED means the seating attempt threw (seat taken concurrently, member
  // went inactive, infra hiccup) — no human rejected anyone. Routing it to
  // SEAT_REJECTED would tell the room "the host rejected this user" when
  // nobody decided anything; it gets its own event instead so clients can
  // offer a "retry" UI off the persisted `lastError`.
  FAILED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_FAILED,
  CANCELLED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_CANCELLED,
  EXPIRED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_EXPIRED,
};

/** Invitation resolution → outbound socket event. Same rationale as above. */
const INVITATION_RESOLUTION_EVENTS: Partial<Record<SeatInvitationResolution, string>> = {
  ACCEPTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_ACCEPTED,
  REJECTED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_REJECTED,
  // FAILED means the invitee accepted and the seating attempt threw — not
  // that they declined. Routing it to SEAT_INVITATION_REJECTED would tell the
  // room the invitee declined when they didn't; it gets its own event so
  // clients can offer a "retry" UI off the persisted `lastError`.
  FAILED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_FAILED,
  CANCELLED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_CANCELLED,
  EXPIRED: VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_EXPIRED,
};

/**
 * Bridges VR-4 seat domain events on the EVENT_BUS to realtime `video_room.seat_*`
 * broadcasts into the `/video-room` namespace room (cross-instance via the Redis
 * adapter). Mirrors `VideoRoomSocketListener`; seat services never touch sockets.
 * Occupancy changes (taken/left) surface as the coalesced `seat_updated`; request
 * and invitation resolutions route through exhaustive status maps so every
 * resolution reaches its own distinct event (see `REQUEST_RESOLUTION_EVENTS`).
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
    this.bus.subscribe<SeatRequestResolvedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, (e) => {
      const event = REQUEST_RESOLUTION_EVENTS[e.payload.status];
      if (event) this.emit(e.payload.roomId, event, e.payload);
    });
    this.bus.subscribe<SeatInvitationSentEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_SENT, e.payload),
    );
    this.bus.subscribe<SeatInvitationResolvedEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_RESOLVED,
      (e) => {
        const event = INVITATION_RESOLUTION_EVENTS[e.payload.status];
        if (event) this.emit(e.payload.roomId, event, e.payload);
      },
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
    this.bus.subscribe<SeatRequestExpiredEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_EXPIRED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_REQUEST_EXPIRED, e.payload),
    );
    this.bus.subscribe<SeatInvitationExpiredEvent>(VIDEO_ROOM_SEAT_EVENTS.INVITATION_EXPIRED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_EXPIRED, e.payload),
    );
    this.bus.subscribe<SeatInvitationDeliveredEvent>(
      VIDEO_ROOM_SEAT_EVENTS.INVITATION_DELIVERED,
      (e) =>
        this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_INVITATION_DELIVERED, e.payload),
    );
    this.bus.subscribe<SeatQueueUpdatedEvent>(VIDEO_ROOM_SEAT_EVENTS.QUEUE_UPDATED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.SEAT_QUEUE_UPDATED, e.payload),
    );
  }

  private emit(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
