import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { INFRA_PRESENCE_EVENTS, PresenceChangedEvent } from 'src/infra/socket/presence.events';
import { VideoRoomPresenceState } from '../enums';
import { VideoRoomEventService } from '../services/video-room-event.service';
import { VideoRoomSessionService } from '../services/video-room-session.service';
import { VideoRoomStateService } from '../services/video-room-state.service';

/**
 * Disconnect fast-path (VR-3): when the infra layer reports a user's last socket
 * gone (`presence.changed` online=false), promptly flip that user's live
 * video-room sessions to DISCONNECTED (rather than waiting up to a monitor tick),
 * bump the room's reconnecting counter, and publish UserDisconnected. The session
 * monitor remains the guarantee that reclaims sessions that never return; this is
 * the low-latency signal for the common single-device case. Best-effort — a
 * failure here is logged, never thrown (it must not break the socket teardown).
 */
@Injectable()
export class VideoRoomPresenceListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomPresenceListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sessions: VideoRoomSessionService,
    private readonly state: VideoRoomStateService,
    private readonly events: VideoRoomEventService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PresenceChangedEvent>(INFRA_PRESENCE_EVENTS.CHANGED, (e) =>
      this.onPresenceChanged(e.payload).catch((err) =>
        this.logger.warn(`Disconnect fast-path failed: ${(err as Error).message}`),
      ),
    );
  }

  private async onPresenceChanged(payload: { userId: string; online: boolean }): Promise<void> {
    if (payload.online) return; // reconnection is handled by the /reconnect flow

    const socketIds = await this.sessions.listUserSessions(payload.userId);
    for (const socketId of socketIds) {
      const record = await this.sessions.getSession(socketId);
      if (!record) continue;
      await this.sessions.markPresence(socketId, VideoRoomPresenceState.DISCONNECTED);
      await this.state.applyUpdate(record.roomId, (cur) => {
        const reconnecting = cur.reconnectingCount + 1;
        return {
          reconnectingCount: reconnecting,
          onlineCount: Math.max(0, cur.viewerCount - reconnecting),
        };
      });
      await this.events.emitUserDisconnected({
        roomId: record.roomId,
        userId: payload.userId,
        socketId,
        reason: 'connection_lost',
      });
    }
  }
}
