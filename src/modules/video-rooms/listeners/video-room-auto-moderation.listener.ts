// src/modules/video-rooms/listeners/video-room-auto-moderation.listener.ts
import { createHash } from 'node:crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  VIDEO_ROOM_CHAT_EVENTS,
  type ChatMessageSentEvent,
  type ChatSpamDetectedEvent,
} from '../events/video-room-chat.events';
import {
  VIDEO_ROOM_MODERATION_EVENTS,
  type UserReportedEvent,
} from '../events/video-room-moderation.events';
import {
  VIDEO_ROOM_EVENTS,
  type SessionExpiredEvent,
  type UserJoinedEvent,
  type UserLeftEvent,
} from '../events/video-room.events';
import { VideoRoomAutoModerationService } from '../services/video-room-auto-moderation.service';

/**
 * VR-16 Task 20 signal subscription. A pure bridge from the domain events the
 * auto-moderation engine cares about onto its `ModerationSignal` union — it
 * holds no detection logic (no thresholds, no Redis, no config) of its own;
 * every mapped signal is handed straight to
 * `VideoRoomAutoModerationService.handle`, which owns all detector fan-out
 * and enforcement.
 *
 * Signal sources:
 *  - Chat `MESSAGE_SENT` → an unflagged `message` signal. The chat payload
 *    carries raw `content`, not a hash, so this bridge computes the same
 *    `sha1(content.toLowerCase())` the duplicate detector expects (mirrors
 *    `VideoRoomChatRateLimiter`'s own dedup hash) rather than re-deriving the
 *    detector's logic.
 *  - Chat `SPAM_DETECTED` → reconciliation: the chat layer already scanned
 *    this content (`ChatSpamDetectedEvent` fires for content the pipeline
 *    rejected, e.g. a blocked word), so this maps to a `message` signal with
 *    `spamFlagged: true`. That event carries no message content — only a
 *    `ChatSpamKind` (a ~5-value enum) — so `contentHash` is deliberately
 *    OMITTED rather than hashing the kind: a hashed kind would collapse onto
 *    one of five constants and false-positive the duplicate detector after
 *    two unrelated rejections of the same kind. The duplicate detector treats
 *    an absent `contentHash` as "not applicable" and skips; spam/flood
 *    detection are unaffected since they key off real per-user counters, not
 *    the content hash.
 *  - `USER_JOINED` / `USER_LEFT` / `SESSION_EXPIRED` (a member/leave/grace-
 *    window-reclaim transition) → `join_leave` signals; the rapid-join-leave
 *    detector counts transitions without caring which kind it was.
 *  - `UserReportedEvent` → a `report` signal keyed on the reported user.
 */
@Injectable()
export class VideoRoomAutoModerationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly autoMod: VideoRoomAutoModerationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ChatMessageSentEvent>(VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT, (e) =>
      this.autoMod.handle({
        type: 'message',
        roomId: e.payload.roomId,
        userId: e.payload.senderId,
        contentHash: this.hash(e.payload.content),
        spamFlagged: false,
      }),
    );

    this.bus.subscribe<ChatSpamDetectedEvent>(VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED, (e) =>
      this.autoMod.handle({
        type: 'message',
        roomId: e.payload.roomId,
        userId: e.payload.userId,
        // No contentHash: this event carries no message content (only the
        // low-cardinality `kind`), so the duplicate detector must not be fed
        // a proxy value — see the class doc above.
        spamFlagged: true,
      }),
    );

    this.bus.subscribe<UserJoinedEvent>(VIDEO_ROOM_EVENTS.USER_JOINED, (e) =>
      this.autoMod.handle({
        type: 'join_leave',
        roomId: e.payload.roomId,
        userId: e.payload.userId,
      }),
    );

    this.bus.subscribe<UserLeftEvent>(VIDEO_ROOM_EVENTS.USER_LEFT, (e) =>
      this.autoMod.handle({
        type: 'join_leave',
        roomId: e.payload.roomId,
        userId: e.payload.userId,
      }),
    );

    this.bus.subscribe<SessionExpiredEvent>(VIDEO_ROOM_EVENTS.SESSION_EXPIRED, (e) =>
      this.autoMod.handle({
        type: 'join_leave',
        roomId: e.payload.roomId,
        userId: e.payload.userId,
      }),
    );

    this.bus.subscribe<UserReportedEvent>(VIDEO_ROOM_MODERATION_EVENTS.REPORTED, (e) =>
      this.autoMod.handle({
        type: 'report',
        roomId: e.payload.roomId,
        targetUserId: e.payload.targetUserId,
      }),
    );
  }

  /** The same hash shape the duplicate detector's `contentHash` expects. */
  private hash(input: string): string {
    return createHash('sha1').update(input.toLowerCase()).digest('hex');
  }
}
