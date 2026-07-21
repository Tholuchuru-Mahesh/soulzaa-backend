import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, VideoRoomLogAction } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

/** Audited actions → the payload field naming the acting user. */
const AUDITED: Record<string, string> = {
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]: 'senderId',
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_EDITED]: 'editorId',
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED]: 'deletedBy',
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED]: 'pinnedBy',
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED]: 'unpinnedBy',
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]: 'authorId',
  [VIDEO_ROOM_CHAT_EVENTS.MENTIONED]: 'senderId',
  [VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED]: 'actorId',
};

/**
 * GAP 5 (VR-9.1b): the moderator-visible subset of chat actions that
 * additionally get a `VideoRoomLog` row, per the spec's "human-readable
 * moderator-visible actions additionally append to VideoRoomLog". Keyed by the
 * same event name, mapping to the enum action + the payload field naming the
 * actor (not always the same field `AUDITED` uses — e.g. announcement
 * update/delete carry `actorId`, not `authorId`).
 *
 * MESSAGE_SENT and MENTIONED are deliberately absent: high-volume, not
 * moderator actions, and putting them in the human audit trail would drown it.
 * ANNOUNCEMENT_UPDATED/DELETED are not in `AUDITED` (nothing writes them to the
 * machine event stream), but they are still moderator-visible actions, so this
 * listener subscribes to them separately, purely to log.
 */
const LOGGED: Record<string, { action: VideoRoomLogAction; actorField: string }> = {
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED]: {
    action: VideoRoomLogAction.MESSAGE_DELETED,
    actorField: 'deletedBy',
  },
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED]: {
    action: VideoRoomLogAction.MESSAGE_PINNED,
    actorField: 'pinnedBy',
  },
  [VIDEO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED]: {
    action: VideoRoomLogAction.MESSAGE_UNPINNED,
    actorField: 'unpinnedBy',
  },
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED]: {
    action: VideoRoomLogAction.ANNOUNCEMENT_POSTED,
    actorField: 'authorId',
  },
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED]: {
    action: VideoRoomLogAction.ANNOUNCEMENT_UPDATED,
    actorField: 'actorId',
  },
  [VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED]: {
    action: VideoRoomLogAction.ANNOUNCEMENT_DELETED,
    actorField: 'actorId',
  },
  [VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED]: {
    action: VideoRoomLogAction.SETTINGS_CHANGED,
    actorField: 'actorId',
  },
};

/** Events subscribed to solely for the `VideoRoomLog` write (absent from `AUDITED`). */
const LOG_ONLY_EVENTS = [
  VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED,
  VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED,
];

/**
 * Writes every mutating chat action to the append-only `video_room_events`
 * stream — the table VR-1 built for exactly this: an open `eventType` string and
 * a JSON payload.
 *
 * The brief requires ip and request id in the audit trail. They arrive on the
 * event's `audit` block, threaded from the controller's `@RequestMeta()`, which
 * is why chat services accept an audit context they otherwise never read.
 * Socket-originated and system-generated actions have no HTTP request, so the
 * block is absent and the row is written without it rather than skipped.
 */
@Injectable()
export class VideoRoomChatAuditListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomChatAuditListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly events: VideoRoomEventsRepository,
    private readonly rooms: VideoRoomsRepository,
  ) {}

  onModuleInit(): void {
    for (const [eventType, actorField] of Object.entries(AUDITED)) {
      // `subscribe`'s generic defaults to the base `DomainEvent` — one handler
      // covers all seven audited events, so the payload is narrowed by hand
      // (mirrors VideoRoomChatSocketListener / VideoRoomChatSystemListener).
      this.bus.subscribe(eventType, (event) => {
        const payload = event.payload as Record<string, unknown>;
        const audit = (payload.audit ?? {}) as Record<string, unknown>;
        void this.events
          .appendEvent({
            roomId: payload.roomId as string,
            actorId: (payload[actorField] as string | undefined) ?? null,
            eventType,
            referenceId: (payload.messageId as string | undefined) ?? null,
            payload: {
              timestamp: event.occurredAt,
              ip: (audit.ip as string | undefined) ?? null,
              requestId: (audit.requestId as string | undefined) ?? null,
              userAgent: (audit.userAgent as string | undefined) ?? null,
            } as Prisma.InputJsonValue,
          })
          .catch((error: Error) =>
            // Audit matters, but it must not break chat delivery.
            this.logger.error(`Chat audit write failed for ${eventType}: ${error.message}`),
          );

        this.writeLog(eventType, payload);
      });
    }

    // ANNOUNCEMENT_UPDATED/DELETED have no event-stream subscriber above (see
    // `LOG_ONLY_EVENTS`), but they are still moderator-visible actions that
    // must reach `VideoRoomLog`.
    for (const eventType of LOG_ONLY_EVENTS) {
      this.bus.subscribe(eventType, (event) => {
        this.writeLog(eventType, event.payload as Record<string, unknown>);
      });
    }
  }

  /**
   * GAP 5 (VR-9.1b): append a `VideoRoomLog` row for the moderator-visible
   * subset of chat actions defined in `LOGGED`. A no-op for every event not in
   * that map (e.g. MESSAGE_SENT, MENTIONED). Fire-and-forget, same rationale as
   * the event-stream write above — a log write must never break chat delivery.
   */
  private writeLog(eventType: string, payload: Record<string, unknown>): void {
    const mapping = LOGGED[eventType];
    if (!mapping) return;

    const metadata: Record<string, unknown> = {};
    if (typeof payload.messageId === 'string') metadata.messageId = payload.messageId;
    if (typeof payload.announcementId === 'string')
      metadata.announcementId = payload.announcementId;

    void this.rooms
      .appendLog({
        roomId: payload.roomId as string,
        actorId: (payload[mapping.actorField] as string | undefined) ?? null,
        action: mapping.action,
        ...(Object.keys(metadata).length > 0
          ? { metadata: metadata as Prisma.InputJsonValue }
          : {}),
      })
      .catch((error: Error) =>
        // Moderator log matters, but it must not break chat delivery.
        this.logger.error(`Chat log write failed for ${eventType}: ${error.message}`),
      );
  }
}
