import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_ROLE_EVENTS } from '../events/video-room-role.events';
import { VIDEO_ROOM_SEAT_EVENTS } from '../events/video-room-seat.events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VideoRoomSystemMessageService } from '../services/video-room-system-message.service';

/** Seat-request resolutions that become a system message. Others emit nothing. */
const SEAT_RESOLUTION_KINDS: Record<string, string> = {
  ACCEPTED: 'SEAT_APPROVED',
  PROMOTED: 'SEAT_APPROVED',
  REJECTED: 'SEAT_REJECTED',
};

/**
 * Turns existing VR-2/3/6/7/8 domain events into chat system messages. Every one
 * of the brief's 13 triggers already exists as a published event, so this adds
 * ZERO new event plumbing — it only decides which existing events deserve a line
 * in the chat stream, and the policy map decides whether that line is persisted.
 *
 * Unmapped cases emit nothing at all, which is always safer than emitting the
 * wrong thing.
 *
 * 11 distinct bus events are subscribed; two of them (LOCKED, REQUEST_RESOLVED)
 * each fan out to more than one message kind depending on their payload, which is
 * how 11 subscriptions cover all 13 `SYSTEM_MESSAGE_POLICY` kinds.
 */
@Injectable()
export class VideoRoomChatSystemListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomChatSystemListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly system: VideoRoomSystemMessageService,
  ) {}

  onModuleInit(): void {
    this.simple(VIDEO_ROOM_EVENTS.USER_JOINED, 'USER_JOINED');
    this.simple(VIDEO_ROOM_EVENTS.USER_LEFT, 'USER_LEFT');
    this.simple(VIDEO_ROOM_EVENTS.VIEWER_JOINED, 'VIEWER_JOINED');
    this.simple(VIDEO_ROOM_EVENTS.VIEWER_LEFT, 'VIEWER_LEFT');
    this.simple(VIDEO_ROOM_EVENTS.VIEWER_PROMOTED, 'PROMOTED');
    this.simple(VIDEO_ROOM_EVENTS.VIEWER_DEMOTED, 'DEMOTED');
    this.simple(VIDEO_ROOM_EVENTS.CLOSED, 'ROOM_CLOSED');
    this.simple(VIDEO_ROOM_ROLE_EVENTS.OWNERSHIP_TRANSFERRED, 'OWNER_CHANGED');
    this.simple(VIDEO_ROOM_SEAT_EVENTS.INVITATION_SENT, 'SEAT_INVITATION');

    // One bus event carries both lock states — split it, or the room is told
    // the opposite of what happened.
    this.bus.subscribe(VIDEO_ROOM_EVENTS.LOCKED, (event) => {
      const payload = event.payload as { roomId: string; isLocked: boolean };
      this.dispatch(payload.isLocked ? 'ROOM_LOCKED' : 'ROOM_UNLOCKED', payload.roomId, payload);
    });

    this.bus.subscribe(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, (event) => {
      const payload = event.payload as { roomId: string; status: string } & Record<string, unknown>;
      const kind = SEAT_RESOLUTION_KINDS[payload.status];
      if (kind) this.dispatch(kind, payload.roomId, payload);
    });
  }

  private simple(busEvent: string, kind: string): void {
    // `subscribe`'s generic defaults to the base `DomainEvent<unknown>` — every
    // one of these events already guarantees a `roomId`, so the payload is
    // narrowed by hand rather than importing each concrete event class.
    this.bus.subscribe(busEvent, (event) => {
      const payload = event.payload as { roomId: string } & Record<string, unknown>;
      this.dispatch(kind, payload.roomId, payload);
    });
  }

  /**
   * Fire-and-forget: a system message is a courtesy, so a failure here must
   * never propagate back into the domain flow that triggered it.
   */
  private dispatch(kind: string, roomId: string, data: Record<string, unknown>): void {
    const { roomId: _roomId, ...rest } = data;
    void this.system
      .emit(kind, roomId, rest)
      .catch((error: Error) =>
        this.logger.warn(`System message ${kind} for room ${roomId} failed: ${error.message}`),
      );
  }
}
