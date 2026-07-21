import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { VideoRoomMessageType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/**
 * The abuse kinds that are specifically RATE limiting, and so additionally bump
 * the rate-limit violation counter. `duplicate` and `blocked_word` are abuse
 * signals but not rate limiting, so they count as spam only.
 */
const RATE_LIMIT_KINDS = new Set<string>(['cooldown', 'rate', 'flood']);

/**
 * Chat observability, decoupled from the write path on purpose. Counting inside
 * `send()` would put a Prometheus call on the hot path and couple message
 * delivery to metrics; subscribing to the same bus event the socket listener
 * uses costs nothing and means metrics can never break a send (VR-4 precedent).
 */
@Injectable()
export class VideoRoomChatMetricsListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomChatMetricsListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly metrics: VideoRoomsMetrics,
    private readonly rooms: VideoRoomsRepository,
  ) {}

  onModuleInit(): void {
    // `subscribe`'s generic defaults to the base `DomainEvent` — the concrete
    // chat event classes aren't imported here since each handler only needs a
    // couple of fields, so the payload is narrowed by hand (mirrors
    // VideoRoomChatSocketListener / VideoRoomChatSystemListener).
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT, (event) => {
      const payload = event.payload as { roomId: string; type: string; createdAt: string };
      this.metrics.incChatMessage(payload.type);
      this.metrics.observeChatLatency(this.elapsed(payload.createdAt, event.occurredAt));

      // GAP 4 (VR-9.1b): `VideoRoomStatistics.totalChatMessages` is read by the
      // detail mapper but was never written. Bumped here, off the send path,
      // fire-and-forget — a stats write must never break chat delivery. SYSTEM
      // rows (joins/leaves projected into chat) are skipped so the counter
      // measures conversation, not presence churn.
      if (payload.type !== VideoRoomMessageType.SYSTEM) {
        void this.rooms
          .bumpChatMessageCount(payload.roomId)
          .catch((error: Error) =>
            this.logger.error(
              `Chat message count bump failed for room ${payload.roomId}: ${error.message}`,
            ),
          );
      }
    });

    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELIVERED, (event) => {
      const payload = event.payload as { at: string };
      this.metrics.observeChatDelivery(this.elapsed(payload.at, event.occurredAt));
    });

    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.MESSAGE_READ, (event) => {
      const payload = event.payload as { at: string };
      this.metrics.observeChatRead(this.elapsed(payload.at, event.occurredAt));
    });

    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.TYPING_STARTED, () => this.metrics.incTypingEvent());
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.TYPING_STOPPED, () => this.metrics.incTypingEvent());

    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED, () =>
      this.metrics.incAnnouncement('created'),
    );
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED, () =>
      this.metrics.incAnnouncement('updated'),
    );
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED, () =>
      this.metrics.incAnnouncement('deleted'),
    );

    // VR-9.2 (G3): the brief's MONITORING section names "Spam Detection" and
    // "Rate Limit Violations". Counted here rather than in the limiter so the
    // rejection path of every send stays free of a Prometheus dependency.
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED, (event) => {
      const payload = event.payload as { kind: string };
      this.metrics.incSpamDetected(payload.kind);
      if (RATE_LIMIT_KINDS.has(payload.kind)) {
        this.metrics.incChatRateLimitViolation();
      }
    });
  }

  /** Seconds between two ISO instants, floored at 0 to tolerate clock skew. */
  private elapsed(from: string, to: string): number {
    return Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 1000);
  }
}
