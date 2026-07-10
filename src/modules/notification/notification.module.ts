import { Global, Module } from '@nestjs/common';
import { NotificationController } from './controllers/notification.controller';
import { NOTIFICATION_SERVICE } from './interfaces/notification.interface';
import { SocialNotificationListener } from './listeners/social-notification.listener';
import { NotificationRepository } from './repositories/notification.repository';
import { NotificationService } from './services/notification.service';

/**
 * Notification domain — durable in-app notifications + preferences. Owns its
 * Prisma tables; other domains never write them. A bridge listener turns social
 * domain events (friend/follow/invite) into notification rows. Realtime delivery
 * of those same events rides each producer's socket layer.
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
    { provide: NOTIFICATION_SERVICE, useExisting: NotificationService },
  ],
  exports: [NOTIFICATION_SERVICE],
})
export class NotificationModule {}
