import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_EVENTS,
  type UserDisconnectedEvent,
  type UserReconnectedEvent,
} from '../events/video-room.events';
import { VideoRoomPkRecoveryService } from '../services/video-room-pk-recovery.service';

/**
 * Bridges room-wide presence (VR-3's `UserDisconnectedEvent`/
 * `UserReconnectedEvent` — published by `VideoRoomPresenceListener`'s socket
 * fast-path, `VideoRoomSessionService`'s reclaim path, and the member
 * service's `/reconnect` flow) into PK's host-drop recovery (VR-12 Task 20).
 *
 * Without this listener `VideoRoomPkRecoveryService.handleHostDrop`/
 * `handleHostReturn` had zero callers: `RECOVERING` was unreachable, the
 * orphan-timeout sweep never fired, `PkRecoveredEvent` never published, and
 * `recoveryGraceSeconds` was dead config. This is deliberately the ONLY new
 * wiring — no new bus events, per the review fix that flagged the gap.
 *
 * Dispatch only: `handleHostDrop`/`handleHostReturn` already do the real
 * work, including the guard that a disconnecting/reconnecting user must
 * actually hold a `VideoRoomPkParticipant` row on a LIVE/RECOVERING battle in
 * that room, so any other member's presence change is a no-op there. This
 * listener's only added responsibility is making sure a recovery fault can
 * never break presence handling for the rest of the room: every call is
 * caught and logged, never rethrown onto the bus.
 */
@Injectable()
export class VideoRoomPkRecoveryListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomPkRecoveryListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly recovery: VideoRoomPkRecoveryService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserDisconnectedEvent>(VIDEO_ROOM_EVENTS.USER_DISCONNECTED, (e) =>
      this.recovery
        .handleHostDrop(e.payload.roomId, e.payload.userId)
        .catch((err) =>
          this.logger.warn(`PK host-drop recovery failed: ${(err as Error).message}`),
        ),
    );
    this.bus.subscribe<UserReconnectedEvent>(VIDEO_ROOM_EVENTS.USER_RECONNECTED, (e) =>
      this.recovery
        .handleHostReturn(e.payload.roomId, e.payload.userId)
        .catch((err) =>
          this.logger.warn(`PK host-return recovery failed: ${(err as Error).message}`),
        ),
    );
  }
}
