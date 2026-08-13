import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';
import { SYSTEM_MODERATOR_ID } from '../constants/moderation.constants';
import {
  AUDIO_ROOM_MODERATION_EVENTS,
  type AppealResolvedEvent,
  type AppealSubmittedEvent,
  type MemberBannedEvent,
  type MemberKickedEvent,
  type MemberMutedEvent,
  type MemberReportedEvent,
  type MemberUnbannedEvent,
  type MemberUnkickedEvent,
  type MemberUnmutedEvent,
  type MemberWarnedEvent,
} from '../events/audio-room-moderation.events';

/**
 * Bridges AR-3 moderation domain events to sockets. Room-facing outcomes
 * (kick/ban/unban/mute/unmute) broadcast to the `/audio-room` namespace room so
 * every participant syncs; the kicked/banned user is additionally targeted
 * cross-room so their client leaves. Warnings, reports and appeals are delivered
 * only to their recipients (the target / the room's moderators), never broadcast.
 */
@Injectable()
export class ModerationSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<MemberKickedEvent>(AUDIO_ROOM_MODERATION_EVENTS.KICKED, (e) => {
      const payload = this.anonymize(e.payload);
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.MEMBER_KICKED, payload);
      this.user(e.payload.targetUserId, ROOM_SOCKET_EVENTS.MEMBER_KICKED, payload);
    });
    this.bus.subscribe<MemberUnkickedEvent>(AUDIO_ROOM_MODERATION_EVENTS.UNKICKED, (e) => {
      const payload = this.anonymize(e.payload);
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.MEMBER_UNKICKED, payload);
      this.user(e.payload.targetUserId, ROOM_SOCKET_EVENTS.MEMBER_UNKICKED, payload);
    });
    this.bus.subscribe<MemberBannedEvent>(AUDIO_ROOM_MODERATION_EVENTS.BANNED, (e) => {
      const payload = this.anonymize(e.payload);
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.MEMBER_BANNED, payload);
      this.user(e.payload.targetUserId, ROOM_SOCKET_EVENTS.MEMBER_BANNED, payload);
    });
    this.bus.subscribe<MemberUnbannedEvent>(AUDIO_ROOM_MODERATION_EVENTS.UNBANNED, (e) => {
      const payload = this.anonymize(e.payload);
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.MEMBER_UNBANNED, payload);
      this.user(e.payload.targetUserId, ROOM_SOCKET_EVENTS.MEMBER_UNBANNED, payload);
    });
    this.bus.subscribe<MemberMutedEvent>(AUDIO_ROOM_MODERATION_EVENTS.MUTED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.MEMBER_MUTED, this.anonymize(e.payload)),
    );
    this.bus.subscribe<MemberUnmutedEvent>(AUDIO_ROOM_MODERATION_EVENTS.UNMUTED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.MEMBER_UNMUTED, this.anonymize(e.payload)),
    );
    this.bus.subscribe<MemberWarnedEvent>(AUDIO_ROOM_MODERATION_EVENTS.WARNED, (e) =>
      this.user(e.payload.targetUserId, ROOM_SOCKET_EVENTS.MEMBER_WARNED, this.anonymize(e.payload)),
    );
    this.bus.subscribe<MemberReportedEvent>(AUDIO_ROOM_MODERATION_EVENTS.REPORTED, (e) =>
      e.payload.recipientIds.forEach((id) =>
        this.user(id, ROOM_SOCKET_EVENTS.MEMBER_REPORTED, e.payload),
      ),
    );
    this.bus.subscribe<AppealSubmittedEvent>(AUDIO_ROOM_MODERATION_EVENTS.APPEAL_SUBMITTED, (e) =>
      e.payload.recipientIds.forEach((id) =>
        this.user(id, ROOM_SOCKET_EVENTS.APPEAL_SUBMITTED, e.payload),
      ),
    );
    this.bus.subscribe<AppealResolvedEvent>(AUDIO_ROOM_MODERATION_EVENTS.APPEAL_RESOLVED, (e) =>
      this.user(e.payload.userId, ROOM_SOCKET_EVENTS.APPEAL_RESOLVED, e.payload),
    );
  }

  private anonymize<T extends { moderatorId: string }>(
    payload: T,
  ): T & { systemMessage: string } {
    return {
      ...payload,
      moderatorId: SYSTEM_MODERATOR_ID,
      systemMessage: 'A moderator took action on this user for violating community guidelines.',
    };
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }

  private user(userId: string, event: string, payload: unknown): void {
    this.sockets.emitToUserEverywhere(userId, event, payload);
  }
}
