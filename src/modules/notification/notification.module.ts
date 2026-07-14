import { Global, Module } from '@nestjs/common';
import { NotificationController } from './controllers/notification.controller';
import { NOTIFICATION_SERVICE } from './interfaces/notification.interface';
import { ChatNotificationListener } from './listeners/chat-notification.listener';
import { GiftNotificationListener } from './listeners/gift-notification.listener';
import { NotificationSocketListener } from './listeners/notification-socket.listener';
import { SocialNotificationListener } from './listeners/social-notification.listener';
import { NotificationPreferenceRepository } from './repositories/notification-preference.repository';
import { NotificationRepository } from './repositories/notification.repository';
import { NotificationService } from './services/notification.service';
import { PushPolicy } from './services/push.policy';

/**
 * Notification domain — durable in-app notifications, the user's delivery
 * preferences, and the single door through which every other module reaches a
 * phone. Owns its Prisma tables; nothing else writes them.
 *
 * Bridge listeners turn domain events (chat, social, gifts) into notification rows
 * *and* into preference-gated push. A socket listener fans the rows themselves out
 * on `/notifications`, which is what turns the bell badge from a poll into a push.
 *
 * @Global so producers resolve NOTIFICATION_SERVICE by token without importing.
 * This module depends on DEVICE_SERVICE (also @Global) for the transport, and the
 * device module does not depend back on it: the login alert is the one push that
 * deliberately bypasses preferences, so it needs nothing from here.
 */
@Global()
@Module({
  controllers: [NotificationController],
  providers: [
    // repositories
    NotificationRepository,
    NotificationPreferenceRepository,
    // services
    PushPolicy,
    NotificationService,
    // listeners
    SocialNotificationListener,
    ChatNotificationListener,
    GiftNotificationListener,
    NotificationSocketListener,
    // public token
    { provide: NOTIFICATION_SERVICE, useExisting: NotificationService },
  ],
  exports: [NOTIFICATION_SERVICE],
})
export class NotificationModule {}
