import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';
import {
  AUDIO_ROOM_CHAT_EVENTS,
  type ChatAnnouncementEvent,
  type ChatMentionEvent,
  type ChatMessageDeletedEvent,
  type ChatMessagePinnedEvent,
  type ChatMessageSentEvent,
  type ChatMessageUnpinnedEvent,
  type ChatReactionEvent,
  type ChatReportedEvent,
  type ChatTypingEvent,
} from '../events/audio-room-chat.events';

/**
 * Bridges AR-4 chat domain events to sockets. Room-facing events (message,
 * typing, pin/unpin, delete, reaction, announcement) broadcast to the
 * `/audio-room` namespace room so every participant syncs in realtime;
 * mentions and reports are delivered only to their recipients (mentioned users /
 * the room's moderators), never broadcast. Persist-then-publish upstream gives
 * the delivery guarantee — a message row exists before this fires.
 */
@Injectable()
export class ChatSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<ChatMessageSentEvent>(AUDIO_ROOM_CHAT_EVENTS.MESSAGE_SENT, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.CHAT_MESSAGE, e.payload),
    );
    this.bus.subscribe<ChatAnnouncementEvent>(AUDIO_ROOM_CHAT_EVENTS.ANNOUNCEMENT, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.CHAT_ANNOUNCEMENT, e.payload),
    );
    this.bus.subscribe<ChatTypingEvent>(AUDIO_ROOM_CHAT_EVENTS.TYPING, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.CHAT_TYPING, e.payload),
    );
    this.bus.subscribe<ChatReactionEvent>(AUDIO_ROOM_CHAT_EVENTS.REACTION, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.CHAT_REACTION, e.payload),
    );
    this.bus.subscribe<ChatMessagePinnedEvent>(AUDIO_ROOM_CHAT_EVENTS.MESSAGE_PINNED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.CHAT_PINNED, e.payload),
    );
    this.bus.subscribe<ChatMessageUnpinnedEvent>(AUDIO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.CHAT_UNPINNED, e.payload),
    );
    this.bus.subscribe<ChatMessageDeletedEvent>(AUDIO_ROOM_CHAT_EVENTS.MESSAGE_DELETED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.CHAT_DELETED, e.payload),
    );
    this.bus.subscribe<ChatMentionEvent>(AUDIO_ROOM_CHAT_EVENTS.MENTION, (e) =>
      e.payload.recipientIds.forEach((id) =>
        this.user(id, ROOM_SOCKET_EVENTS.CHAT_MENTION, e.payload),
      ),
    );
    this.bus.subscribe<ChatReportedEvent>(AUDIO_ROOM_CHAT_EVENTS.REPORTED, (e) =>
      e.payload.recipientIds.forEach((id) =>
        this.user(id, ROOM_SOCKET_EVENTS.CHAT_REPORTED, e.payload),
      ),
    );
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }

  private user(userId: string, event: string, payload: unknown): void {
    this.sockets.emitToUserEverywhere(userId, event, payload);
  }
}
