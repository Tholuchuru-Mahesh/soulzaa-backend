import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { NotificationService } from '../services/notification.service';

/**
 * A received gift is worth money, so it is worth telling someone about even when
 * they were not looking.
 *
 * Only the *receiver* is notified, and never for their own send — a gift sent to
 * oneself (which the gift domain permits, for combo mechanics) must not ring the
 * sender's own phone.
 */
@Injectable()
export class GiftNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => this.onGiftSent(e));
  }

  private async onGiftSent(e: GiftSentEvent): Promise<void> {
    const { receiverId, senderId, giftName, quantity, transactionId, totalCoinValue } = e.payload;
    if (receiverId === senderId) return;

    const [card] = await this.profile.getCards([senderId]);
    const senderName = card ? (card.fullName ?? card.username) : 'Someone';
    const what = quantity > 1 ? `${giftName} ×${quantity}` : giftName;

    await this.notifications.create({
      userId: receiverId,
      type: NotificationType.GIFT_RECEIVED,
      actorId: senderId,
      entityType: 'gift_transaction',
      entityId: transactionId,
      data: {
        ...(card
          ? { username: card.username, fullName: card.fullName, avatarUrl: card.avatarUrl }
          : {}),
        giftName,
        quantity,
        totalCoinValue,
      },
    });

    await this.notifications.notify(receiverId, {
      category: PUSH_CATEGORIES.GIFT,
      title: senderName,
      body: `Sent you ${what}`,
      // The gift's *name* is not private, but its value is — a lock screen does not
      // need to advertise how much someone just spent on this user.
      redactedBody: 'Sent you a gift',
      threadId: `gift_${receiverId}`,
      badge: 'unread',
      data: {
        type: 'gift_received',
        transactionId,
        senderId,
        senderName,
        giftName,
        quantity: String(quantity),
      },
    });
  }
}
