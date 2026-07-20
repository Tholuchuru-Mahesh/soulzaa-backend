import { Inject, Injectable } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  HeartbeatMissedEvent,
  HostConnectedEvent,
  HostDisconnectedEvent,
  PresenceUpdatedEvent,
  RoomClosedEvent,
  RoomCreatedEvent,
  RoomDeletedEvent,
  RoomLockedEvent,
  RoomRestoredEvent,
  RoomSynchronizedEvent,
  RoomUpdatedEvent,
  SessionCreatedEvent,
  SessionExpiredEvent,
  StreamStartedEvent,
  StreamStoppedEvent,
  UserDisconnectedEvent,
  UserJoinedEvent,
  UserLeftEvent,
  UserReconnectedEvent,
  ViewerJoinedEvent,
  ViewerLeftEvent,
} from '../events/video-room.events';
import {
  ViewerDemotedEvent,
  ViewerPresenceChangedEvent,
  ViewerPromotedEvent,
} from '../events/video-room-viewer.events';

/**
 * Single typed surface through which video-room services publish domain events
 * to the EVENT_BUS. Keeps `new XxxEvent(...)` construction in one place so later
 * phases publish through a stable, discoverable API (the socket listener + any
 * downstream module subscribe to the same event names). VR-0 wires this; the
 * business flows that call it arrive with their phases.
 */
@Injectable()
export class VideoRoomEventService {
  constructor(@Inject(EVENT_BUS) private readonly bus: IEventBus) {}

  emitRoomCreated(payload: RoomCreatedEvent['payload']): Promise<void> {
    return this.bus.publish(new RoomCreatedEvent(payload));
  }

  emitRoomClosed(payload: RoomClosedEvent['payload']): Promise<void> {
    return this.bus.publish(new RoomClosedEvent(payload));
  }

  emitRoomUpdated(payload: RoomUpdatedEvent['payload']): Promise<void> {
    return this.bus.publish(new RoomUpdatedEvent(payload));
  }

  emitRoomDeleted(payload: RoomDeletedEvent['payload']): Promise<void> {
    return this.bus.publish(new RoomDeletedEvent(payload));
  }

  emitRoomLocked(payload: RoomLockedEvent['payload']): Promise<void> {
    return this.bus.publish(new RoomLockedEvent(payload));
  }

  emitRoomRestored(payload: RoomRestoredEvent['payload']): Promise<void> {
    return this.bus.publish(new RoomRestoredEvent(payload));
  }

  emitUserJoined(payload: UserJoinedEvent['payload']): Promise<void> {
    return this.bus.publish(new UserJoinedEvent(payload));
  }

  emitUserLeft(payload: UserLeftEvent['payload']): Promise<void> {
    return this.bus.publish(new UserLeftEvent(payload));
  }

  emitViewerJoined(payload: ViewerJoinedEvent['payload']): Promise<void> {
    return this.bus.publish(new ViewerJoinedEvent(payload));
  }

  emitViewerLeft(payload: ViewerLeftEvent['payload']): Promise<void> {
    return this.bus.publish(new ViewerLeftEvent(payload));
  }

  emitHostConnected(payload: HostConnectedEvent['payload']): Promise<void> {
    return this.bus.publish(new HostConnectedEvent(payload));
  }

  emitHostDisconnected(payload: HostDisconnectedEvent['payload']): Promise<void> {
    return this.bus.publish(new HostDisconnectedEvent(payload));
  }

  emitStreamStarted(payload: StreamStartedEvent['payload']): Promise<void> {
    return this.bus.publish(new StreamStartedEvent(payload));
  }

  emitStreamStopped(payload: StreamStoppedEvent['payload']): Promise<void> {
    return this.bus.publish(new StreamStoppedEvent(payload));
  }

  // ---- VR-3 member/presence/session lifecycle ----

  emitUserDisconnected(payload: UserDisconnectedEvent['payload']): Promise<void> {
    return this.bus.publish(new UserDisconnectedEvent(payload));
  }

  emitUserReconnected(payload: UserReconnectedEvent['payload']): Promise<void> {
    return this.bus.publish(new UserReconnectedEvent(payload));
  }

  emitPresenceUpdated(payload: PresenceUpdatedEvent['payload']): Promise<void> {
    return this.bus.publish(new PresenceUpdatedEvent(payload));
  }

  emitHeartbeatMissed(payload: HeartbeatMissedEvent['payload']): Promise<void> {
    return this.bus.publish(new HeartbeatMissedEvent(payload));
  }

  emitSessionCreated(payload: SessionCreatedEvent['payload']): Promise<void> {
    return this.bus.publish(new SessionCreatedEvent(payload));
  }

  emitSessionExpired(payload: SessionExpiredEvent['payload']): Promise<void> {
    return this.bus.publish(new SessionExpiredEvent(payload));
  }

  emitRoomSynchronized(payload: RoomSynchronizedEvent['payload']): Promise<void> {
    return this.bus.publish(new RoomSynchronizedEvent(payload));
  }

  // ---- VR-6 viewer mode ----

  emitViewerPromoted(payload: ViewerPromotedEvent['payload']): Promise<void> {
    return this.bus.publish(new ViewerPromotedEvent(payload));
  }

  emitViewerDemoted(payload: ViewerDemotedEvent['payload']): Promise<void> {
    return this.bus.publish(new ViewerDemotedEvent(payload));
  }

  emitViewerPresenceChanged(payload: ViewerPresenceChangedEvent['payload']): Promise<void> {
    return this.bus.publish(new ViewerPresenceChangedEvent(payload));
  }
}
