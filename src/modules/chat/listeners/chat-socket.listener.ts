import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { USER_ROOM_PREFIX } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { CHAT_NAMESPACE, CHAT_SOCKET_EVENTS } from '../constants/chat.constants';
import {
  CHAT_EVENTS,
  type ChatTypingEvent,
  type ConversationAcceptedEvent,
  type ConversationClearedEvent,
  type ConversationCreatedEvent,
  type ConversationDeclinedEvent,
  type ConversationDraftChangedEvent,
  type ConversationSettingsChangedEvent,
  type MessageDeletedEvent,
  type MessageDeliveredEvent,
  type MessageEditedEvent,
  type MessageReactionEvent,
  type MessageReadEvent,
  type MessageSentEvent,
} from '../events/chat.events';

/**
 * Bridges chat domain events to the `/chat` namespace. Every event is delivered
 * into each recipient's per-user room (`user:<id>`) — not a conversation room —
 * which is what makes multi-device sync automatic: all of a user's sockets are
 * already in that room, so a read receipt raised on their phone reaches their
 * tablet with no extra bookkeeping.
 *
 * Persist-then-publish upstream gives the delivery guarantee: by the time this
 * fires, the row exists.
 *
 * `conversation.created` is the one event whose payload differs per recipient
 * (each side sees the other as `peer`, and only one side sees it as a request),
 * so it carries a per-user view map rather than a single shared body.
 */
@Injectable()
export class ChatSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    // ---- Conversations ----
    this.bus.subscribe<ConversationCreatedEvent>(CHAT_EVENTS.CONVERSATION_CREATED, (e) => {
      for (const userId of e.payload.recipientIds) {
        const view = e.payload.views[userId];
        if (view) this.toUser(userId, CHAT_SOCKET_EVENTS.CONVERSATION_CREATED, view);
      }
    });

    this.bus.subscribe<ConversationAcceptedEvent>(CHAT_EVENTS.CONVERSATION_ACCEPTED, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.CONVERSATION_ACCEPTED, {
        conversationId: e.payload.conversationId,
        acceptedBy: e.payload.acceptedBy,
      }),
    );

    this.bus.subscribe<ConversationDeclinedEvent>(CHAT_EVENTS.CONVERSATION_DECLINED, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.CONVERSATION_DECLINED, {
        conversationId: e.payload.conversationId,
        declinedBy: e.payload.declinedBy,
      }),
    );

    this.bus.subscribe<ConversationClearedEvent>(CHAT_EVENTS.CONVERSATION_CLEARED, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.CONVERSATION_CLEARED, {
        conversationId: e.payload.conversationId,
        clearedAt: e.payload.clearedAt,
      }),
    );

    this.bus.subscribe<ConversationSettingsChangedEvent>(CHAT_EVENTS.CONVERSATION_SETTINGS, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.CONVERSATION_SETTINGS, {
        conversationId: e.payload.conversationId,
        isPinned: e.payload.isPinned,
        isArchived: e.payload.isArchived,
        isFavorite: e.payload.isFavorite,
        isMuted: e.payload.isMuted,
        mutedUntil: e.payload.mutedUntil,
      }),
    );

    this.bus.subscribe<ConversationDraftChangedEvent>(CHAT_EVENTS.CONVERSATION_DRAFT, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.CONVERSATION_DRAFT, {
        conversationId: e.payload.conversationId,
        draft: e.payload.draft,
        draftAt: e.payload.draftAt,
      }),
    );

    // ---- Messages ----
    this.bus.subscribe<MessageSentEvent>(CHAT_EVENTS.MESSAGE_SENT, (e) =>
      // The sender's own devices get the echo too — that is how an optimistic
      // client reconciles its pending bubble (match on `clientId`) and how the
      // sender's other devices learn about a message they did not compose.
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.MESSAGE_NEW, e.payload.message),
    );

    this.bus.subscribe<MessageDeletedEvent>(CHAT_EVENTS.MESSAGE_DELETED, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.MESSAGE_DELETED, {
        conversationId: e.payload.conversationId,
        messageId: e.payload.messageId,
        deletedBy: e.payload.deletedBy,
      }),
    );

    this.bus.subscribe<MessageEditedEvent>(CHAT_EVENTS.MESSAGE_EDITED, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.MESSAGE_EDITED, e.payload.message),
    );

    this.bus.subscribe<MessageReactionEvent>(CHAT_EVENTS.MESSAGE_REACTION, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.MESSAGE_REACTION, {
        conversationId: e.payload.conversationId,
        messageId: e.payload.messageId,
        userId: e.payload.userId,
        emoji: e.payload.emoji,
        added: e.payload.added,
      }),
    );

    // ---- Receipts & indicators ----
    this.bus.subscribe<MessageDeliveredEvent>(CHAT_EVENTS.MESSAGE_DELIVERED, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.MESSAGE_DELIVERED, {
        conversationId: e.payload.conversationId,
        userId: e.payload.userId,
        messageId: e.payload.messageId,
        deliveredAt: e.payload.deliveredAt,
      }),
    );

    this.bus.subscribe<MessageReadEvent>(CHAT_EVENTS.MESSAGE_READ, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.MESSAGE_READ, {
        conversationId: e.payload.conversationId,
        userId: e.payload.userId,
        messageId: e.payload.messageId,
        readAt: e.payload.readAt,
      }),
    );

    this.bus.subscribe<ChatTypingEvent>(CHAT_EVENTS.TYPING, (e) =>
      this.fanOut(e.payload.recipientIds, CHAT_SOCKET_EVENTS.TYPING, {
        conversationId: e.payload.conversationId,
        userId: e.payload.userId,
        isTyping: e.payload.isTyping,
        kind: e.payload.kind,
      }),
    );
  }

  private fanOut(userIds: string[], event: string, payload: unknown): void {
    for (const userId of userIds) this.toUser(userId, event, payload);
  }

  private toUser(userId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(
      CHAT_NAMESPACE,
      `${USER_ROOM_PREFIX}${userId}`,
      event,
      payload,
    );
  }
}
