import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE, VIDEO_ROOM_SOCKET_EVENTS } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_EVENTS,
  type HostConnectedEvent,
  type HostDisconnectedEvent,
  type PresenceUpdatedEvent,
  type RoomClosedEvent,
  type RoomCreatedEvent,
  type RoomDeletedEvent,
  type RoomLockedEvent,
  type RoomRestoredEvent,
  type RoomSynchronizedEvent,
  type RoomUpdatedEvent,
  type StreamStartedEvent,
  type StreamStoppedEvent,
  type UserDisconnectedEvent,
  type UserJoinedEvent,
  type UserLeftEvent,
  type UserReconnectedEvent,
  type ViewerJoinedEvent,
  type ViewerLeftEvent,
} from '../events/video-room.events';
import type {
  ViewerDemotedEvent,
  ViewerPresenceChangedEvent,
  ViewerPromotedEvent,
} from '../events/video-room-viewer.events';

/**
 * Bridges video-room domain events on the EVENT_BUS to realtime `video_room.*`
 * broadcasts into the `/video-room` Socket.IO namespace room, cross-instance via
 * the Redis adapter. The infra VideoRoomGateway (already declared in infra/socket)
 * stays a thin transport shell; all domain fan-out flows through here — the module
 * never depends on a gateway directly. This maps the internal bus event names to
 * the client-facing socket event names (the two vocabularies are intentionally
 * distinct). In VR-0 the listener is wired + tested; business flows publish later.
 */
@Injectable()
export class VideoRoomSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomCreatedEvent>(VIDEO_ROOM_EVENTS.CREATED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.CREATED, e.payload),
    );
    this.bus.subscribe<RoomClosedEvent>(VIDEO_ROOM_EVENTS.CLOSED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.CLOSED, e.payload),
    );
    this.bus.subscribe<RoomUpdatedEvent>(VIDEO_ROOM_EVENTS.UPDATED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.UPDATED, e.payload),
    );
    this.bus.subscribe<RoomLockedEvent>(VIDEO_ROOM_EVENTS.LOCKED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.LOCKED, e.payload),
    );
    this.bus.subscribe<RoomDeletedEvent>(VIDEO_ROOM_EVENTS.DELETED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.DELETED, e.payload),
    );
    // Restore is a state change with no dedicated client event; relay as `updated`.
    this.bus.subscribe<RoomRestoredEvent>(VIDEO_ROOM_EVENTS.RESTORED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.UPDATED, e.payload),
    );
    this.bus.subscribe<UserJoinedEvent>(VIDEO_ROOM_EVENTS.USER_JOINED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.USER_JOINED, e.payload),
    );
    this.bus.subscribe<UserLeftEvent>(VIDEO_ROOM_EVENTS.USER_LEFT, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.USER_LEFT, e.payload),
    );
    this.bus.subscribe<ViewerJoinedEvent>(VIDEO_ROOM_EVENTS.VIEWER_JOINED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.VIEWER_CONNECTED, e.payload),
    );
    this.bus.subscribe<ViewerLeftEvent>(VIDEO_ROOM_EVENTS.VIEWER_LEFT, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.VIEWER_DISCONNECTED, e.payload),
    );
    this.bus.subscribe<HostConnectedEvent>(VIDEO_ROOM_EVENTS.HOST_CONNECTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.HOST_CONNECTED, e.payload),
    );
    this.bus.subscribe<HostDisconnectedEvent>(VIDEO_ROOM_EVENTS.HOST_DISCONNECTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.HOST_DISCONNECTED, e.payload),
    );
    this.bus.subscribe<StreamStartedEvent>(VIDEO_ROOM_EVENTS.STREAM_STARTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_READY, e.payload),
    );
    this.bus.subscribe<StreamStoppedEvent>(VIDEO_ROOM_EVENTS.STREAM_STOPPED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STREAM_CLOSED, e.payload),
    );

    // ---- VR-3 member/presence lifecycle (client-facing) ----
    this.bus.subscribe<UserDisconnectedEvent>(VIDEO_ROOM_EVENTS.USER_DISCONNECTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.USER_DISCONNECTED, e.payload),
    );
    this.bus.subscribe<UserReconnectedEvent>(VIDEO_ROOM_EVENTS.USER_RECONNECTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.USER_RECONNECTED, e.payload),
    );
    this.bus.subscribe<PresenceUpdatedEvent>(VIDEO_ROOM_EVENTS.PRESENCE_UPDATED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.PRESENCE_UPDATED, e.payload),
    );
    // Room sync relays as the client-facing `state_sync` event.
    this.bus.subscribe<RoomSynchronizedEvent>(VIDEO_ROOM_EVENTS.ROOM_SYNCHRONIZED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.STATE_SYNC, e.payload),
    );
    // HEARTBEAT_MISSED / SESSION_CREATED / SESSION_EXPIRED are deliberately NOT
    // relayed to clients (bus-only; analytics/monitoring). SESSION_EVICTED is sent
    // point-to-point by the session service via emitToUserEverywhere, not here.

    // ---- VR-6 viewer mode (client-facing) ----
    this.bus.subscribe<ViewerPromotedEvent>(VIDEO_ROOM_EVENTS.VIEWER_PROMOTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.VIEWER_PROMOTED, e.payload),
    );
    this.bus.subscribe<ViewerDemotedEvent>(VIDEO_ROOM_EVENTS.VIEWER_DEMOTED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.VIEWER_DEMOTED, e.payload),
    );
    this.bus.subscribe<ViewerPresenceChangedEvent>(VIDEO_ROOM_EVENTS.VIEWER_PRESENCE_CHANGED, (e) =>
      this.emit(e.payload.roomId, VIDEO_ROOM_SOCKET_EVENTS.VIEWER_PRESENCE_CHANGED, e.payload),
    );
  }

  private emit(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
