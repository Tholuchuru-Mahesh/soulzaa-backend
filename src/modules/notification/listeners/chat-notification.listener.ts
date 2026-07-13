import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { CHAT_EVENTS, type MessageSentEvent } from 'src/modules/chat/events/chat.events';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { NotificationService } from '../services/notification.service';

/**
 * Bridges chat events into durable in-app notifications. Keeps the write path
 * inside the notification module (which owns the tables); chat only produces
 * events.
 *
 * Only messages the chat service marked as notifiable land here — `notifyIds`
 * already excludes the sender and anyone who muted the conversation, so muting
 * is decided once, in the domain, rather than re-derived by every consumer.
 *
 * A first message from a stranger is a CHAT_REQUEST, not a NEW_MESSAGE: the
 * recipient is being asked to open a conversation, which is a different thing
 * to acknowledge than a message inside one they already accepted.
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

    const [card] = await this.profile.getCards([senderId]);
    const actor = card
      ? { username: card.username, fullName: card.fullName, avatarUrl: card.avatarUrl }
      : null;

    // The preview never carries attachment keys or a media body — a lock-screen
    // notification is not a place to leak private content beyond a short excerpt.
    const preview = message.content.slice(0, 120);

    await Promise.all(
      notifyIds.map((userId) =>
        this.notifications.create({
          userId,
          type: isRequest ? NotificationType.CHAT_REQUEST : NotificationType.NEW_MESSAGE,
          actorId: senderId,
          entityType: 'conversation',
          entityId: message.conversationId,
          data: {
            ...(actor ?? {}),
            messageId: message.id,
            messageType: message.type,
            preview,
          },
        }),
      ),
    );
  }
}
