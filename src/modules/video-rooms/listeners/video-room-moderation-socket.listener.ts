import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  SYSTEM_MODERATOR_ID,
  VIDEO_ROOM_MODERATION_SOCKET_EVENTS,
} from '../constants/video-room-moderation.constants';
import {
  VIDEO_ROOM_MODERATION_EVENTS,
  type ReportReviewedEvent,
  type RoomModerationUpdatedEvent,
  type UserBlacklistedEvent,
  type UserForceDisconnectedEvent,
  type UserKickedEvent,
  type UserMutedEvent,
  type UserReportedEvent,
  type UserUnblacklistedEvent,
  type UserUnkickedEvent,
  type UserUnmutedEvent,
  type UserWarnedEvent,
} from '../events/video-room-moderation.events';

/**
 * Bridges VR-16 moderation domain events on the EVENT_BUS to client-facing
 * `VIDEO_ROOM_MODERATION_SOCKET_EVENTS.*` broadcasts into the `/video-room`
 * namespace. Mirrors the audio-room `ModerationSocketListener`'s room-vs-user
 * split: room-wide outcomes (kick/mute/unmute/blacklist/unblacklist/force
 * disconnect/room-wide config change) broadcast to the room; warnings and
 * report reviews are delivered to the target user only; reports are
 * delivered to each recipient only. Never broadcasts a report to the room.
 * `ModerationActionCompletedEvent` has no dedicated socket broadcast (it's
 * consumed by cross-cutting concerns like metrics/history) so it is
 * intentionally not subscribed here. No business logic lives in this class.
 */
@Injectable()
export class VideoRoomModerationSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserKickedEvent>(VIDEO_ROOM_MODERATION_EVENTS.KICKED, (e) => {
      const payload = this.anonymize(e.payload);
      this.room(e.payload.roomId, VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_KICKED, payload);
      this.user(e.payload.targetUserId, VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_KICKED, payload);
      this.room(e.payload.roomId, 'video_room.kicked', payload);
      this.user(e.payload.targetUserId, 'video_room.kicked', payload);
      this.room(e.payload.roomId, 'room.kicked', payload);
      this.user(e.payload.targetUserId, 'room.kicked', payload);
    });
    this.bus.subscribe<UserUnkickedEvent>(VIDEO_ROOM_MODERATION_EVENTS.UNKICKED, (e) => {
      const payload = this.anonymize(e.payload);
      this.room(e.payload.roomId, VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_UNKICKED, payload);
      this.user(e.payload.targetUserId, VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_UNKICKED, payload);
      this.room(e.payload.roomId, 'video_room.unkicked', payload);
      this.user(e.payload.targetUserId, 'video_room.unkicked', payload);
      this.room(e.payload.roomId, 'room.unkicked', payload);
      this.user(e.payload.targetUserId, 'room.unkicked', payload);
    });
    this.bus.subscribe<UserBlacklistedEvent>(VIDEO_ROOM_MODERATION_EVENTS.BLACKLISTED, (e) => {
      const payload = this.anonymize(e.payload);
      this.room(e.payload.roomId, VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_BLACKLISTED, payload);
      this.user(
        e.payload.targetUserId,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_BLACKLISTED,
        payload,
      );
      this.room(e.payload.roomId, 'video_room.blacklisted', payload);
      this.user(e.payload.targetUserId, 'video_room.blacklisted', payload);
      this.room(e.payload.roomId, 'video_room.banned', payload);
      this.user(e.payload.targetUserId, 'video_room.banned', payload);
      this.room(e.payload.roomId, 'room.banned', payload);
      this.user(e.payload.targetUserId, 'room.banned', payload);
    });
    this.bus.subscribe<UserUnblacklistedEvent>(VIDEO_ROOM_MODERATION_EVENTS.UNBLACKLISTED, (e) => {
      const payload = this.anonymize(e.payload);
      this.room(
        e.payload.roomId,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_UNBLACKLISTED,
        payload,
      );
      this.room(e.payload.roomId, 'video_room.unblacklisted', payload);
      this.room(e.payload.roomId, 'video_room.unbanned', payload);
      this.room(e.payload.roomId, 'room.unbanned', payload);
    });
    this.bus.subscribe<UserMutedEvent>(VIDEO_ROOM_MODERATION_EVENTS.MUTED, (e) =>
      this.room(
        e.payload.roomId,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_MUTED,
        this.anonymize(e.payload),
      ),
    );
    this.bus.subscribe<UserUnmutedEvent>(VIDEO_ROOM_MODERATION_EVENTS.UNMUTED, (e) =>
      this.room(
        e.payload.roomId,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_UNMUTED,
        this.anonymize(e.payload),
      ),
    );
    this.bus.subscribe<UserWarnedEvent>(VIDEO_ROOM_MODERATION_EVENTS.WARNED, (e) =>
      this.user(
        e.payload.targetUserId,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_WARNED,
        this.anonymize(e.payload),
      ),
    );
    this.bus.subscribe<UserForceDisconnectedEvent>(
      VIDEO_ROOM_MODERATION_EVENTS.FORCE_DISCONNECTED,
      (e) => {
        const payload = this.anonymize(e.payload);
        this.room(
          e.payload.roomId,
          VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_FORCE_DISCONNECTED,
          payload,
        );
        this.user(
          e.payload.targetUserId,
          VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_FORCE_DISCONNECTED,
          payload,
        );
      },
    );
    this.bus.subscribe<UserReportedEvent>(VIDEO_ROOM_MODERATION_EVENTS.REPORTED, (e) =>
      e.payload.recipientIds.forEach((id) =>
        this.user(id, VIDEO_ROOM_MODERATION_SOCKET_EVENTS.USER_REPORTED, e.payload),
      ),
    );
    this.bus.subscribe<ReportReviewedEvent>(VIDEO_ROOM_MODERATION_EVENTS.REPORT_REVIEWED, (e) =>
      this.user(
        e.payload.targetUserId,
        VIDEO_ROOM_MODERATION_SOCKET_EVENTS.REPORT_REVIEWED,
        e.payload,
      ),
    );
    this.bus.subscribe<RoomModerationUpdatedEvent>(
      VIDEO_ROOM_MODERATION_EVENTS.ROOM_MODERATION_UPDATED,
      (e) =>
        this.room(
          e.payload.roomId,
          VIDEO_ROOM_MODERATION_SOCKET_EVENTS.ROOM_MODERATION_UPDATED,
          e.payload,
        ),
    );
  }

  private anonymize<T extends { moderatorId: string }>(payload: T): T & { systemMessage: string } {
    return {
      ...payload,
      moderatorId: SYSTEM_MODERATOR_ID,
      systemMessage: 'A moderator took action on this user for violating community guidelines.',
    };
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }

  private user(userId: string, event: string, payload: unknown): void {
    this.sockets.emitToUserEverywhere(userId, event, payload);
  }
}
