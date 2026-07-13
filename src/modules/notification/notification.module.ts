import { Global, Module } from '@nestjs/common';
import { NotificationController } from './controllers/notification.controller';
import { NOTIFICATION_SERVICE } from './interfaces/notification.interface';
import { ChatNotificationListener } from './listeners/chat-notification.listener';
import { SocialNotificationListener } from './listeners/social-notification.listener';
import { NotificationRepository } from './repositories/notification.repository';
import { NotificationService } from './services/notification.service';

/**
 * Notification domain — durable in-app notifications + preferences. Owns its
 * Prisma tables; other domains never write them. Bridge listeners turn social
 * domain events (friend/follow/invite) and chat events (new message / chat
 * request) into notification rows. Realtime delivery of those same events rides
 * each producer's socket layer.
 *
 * @Global so producers resolve NOTIFICATION_SERVICE by token without importing.
 */
@Global()
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationRepository,
    NotificationService,
    SocialNotificationListener,
    ChatNotificationListener,
    { provide: NOTIFICATION_SERVICE, useExisting: NotificationService },
  ],
  exports: [NOTIFICATION_SERVICE],
})
export class NotificationModule {}
