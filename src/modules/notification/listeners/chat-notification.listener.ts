import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DirectMessageType, NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CHAT_EVENTS, type MessageSentEvent } from 'src/modules/chat/events/chat.events';
import type { MessageView } from 'src/modules/chat/interfaces/chat.service.interface';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { NotificationService } from '../services/notification.service';

/** Longest excerpt that ever leaves the server, in a push body or a notification row. */
const PREVIEW_MAX_LENGTH = 120;

/**
 * What a message *is*, for a reader who cannot see it. A media message has no text
 * body worth previewing — "📷 Photo" is the entire content of the notification, and
 * it is also all we are willing to say about it.
 */
const MEDIA_SUMMARY: Partial<Record<DirectMessageType, string>> = {
  [DirectMessageType.IMAGE]: '📷 Photo',
  [DirectMessageType.VIDEO]: '🎥 Video',
  [DirectMessageType.VOICE]: '🎤 Voice message',
  [DirectMessageType.FILE]: '📎 File',
  [DirectMessageType.GIF]: 'GIF',
  [DirectMessageType.STICKER]: 'Sticker',
  [DirectMessageType.GIFT]: '🎁 Sent you a gift',
  [DirectMessageType.PROFILE_SHARE]: 'Shared a profile',
  [DirectMessageType.ROOM_INVITE]: 'Invited you to a room',
};

/**
 * Turns chat events into durable notifications **and** into push.
 *
 * The socket fan-out on `/chat` only reaches a device with a live connection. A
 * backgrounded or dozing phone has none — so without the push half, a message to a
 * user who is not currently staring at the app simply never arrives. That is the
 * half of delivery that decides whether a chat feature is usable at all.
 *
 * Only messages the chat service marked notifiable reach here: `notifyIds` already
 * excludes the sender and anyone who muted the conversation, so per-conversation
 * mute is decided once, in the domain, rather than re-derived by every consumer.
 * The *global* gate (master switch, snooze, "messages off", preview redaction) is
 * applied one layer down, by `NotificationService.notify`.
 *
 * A first message from a stranger is a CHAT_REQUEST, not a NEW_MESSAGE: the
 * recipient is being asked to open a conversation, which is a different thing to
 * acknowledge than a message inside one they already accepted.
 */
@Injectable()
export class ChatNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<MessageSentEvent>(CHAT_EVENTS.MESSAGE_SENT, (e) => this.onMessageSent(e));
  }

  private async onMessageSent(e: MessageSentEvent): Promise<void> {
    const { notifyIds, message, senderId, isRequest } = e.payload;
    if (notifyIds.length === 0) return;

    // A CALL_LOG is written into the thread by the calls module, which has already
    // pushed about that call. Notifying again would ring the phone a second time for
    // one event — and the second time about a call that is already over.
    if (message.type === DirectMessageType.CALL_LOG) return;

    const [card] = await this.profile.getCards([senderId]);
    const senderName = card ? (card.fullName ?? card.username) : 'Someone';
    const actor = card
      ? { username: card.username, fullName: card.fullName, avatarUrl: card.avatarUrl }
      : null;

    const preview = this.preview(message);
    const type = isRequest ? NotificationType.CHAT_REQUEST : NotificationType.NEW_MESSAGE;

    await Promise.all(
      notifyIds.map(async (userId) => {
        await this.notifications.create({
          userId,
          type,
          actorId: senderId,
          entityType: 'conversation',
          entityId: message.conversationId,
          data: {
            ...(actor ?? {}),
            messageId: message.id,
            messageType: message.type,
            preview,
            isReply: message.replyToId !== null,
          },
        });

        await this.notifications.notify(userId, {
          category: PUSH_CATEGORIES.MESSAGE,
          title: senderName,
          body: isRequest ? 'Wants to chat with you' : preview,
          // What the lock screen says when previews are off. A chat request has no
          // private content to hide, so it is its own redaction.
          redactedBody: isRequest ? 'Wants to chat with you' : 'New message',
          priority: 'high',
          // One conversation, one thread: ten messages from the same chat collapse
          // into a single expandable stack instead of ten separate banners.
          threadId: `chat_${message.conversationId}`,
          badge: 'unread',
          data: {
            type: isRequest ? 'chat_request' : 'chat_message',
            conversationId: message.conversationId,
            messageId: message.id,
            messageType: message.type,
            senderId,
            senderName,
            ...(card?.avatarUrl ? { senderAvatar: card.avatarUrl } : {}),
            ...(message.replyToId ? { isReply: 'true' } : {}),
          },
        });
      }),
    );
  }

  /**
   * The excerpt that is allowed to leave the server.
   *
   * Media never previews its content — only its kind. There is no version of putting
   * someone's photo on a lock screen that is a good idea, and a document's filename
   * is frequently more revealing than the document.
   */
  private preview(message: MessageView): string {
    return MEDIA_SUMMARY[message.type] ?? message.content.slice(0, PREVIEW_MAX_LENGTH);
  }
}
