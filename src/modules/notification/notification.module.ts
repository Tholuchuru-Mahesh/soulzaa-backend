import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { NotificationController } from './controllers/notification.controller';
import { NotificationCenterController } from './controllers/notification-center.controller';
import { NOTIFICATION_SERVICE } from './interfaces/notification.interface';
import { ChatNotificationListener } from './listeners/chat-notification.listener';
import { GiftNotificationListener } from './listeners/gift-notification.listener';
import { NotificationSocketListener } from './listeners/notification-socket.listener';
import { SocialNotificationListener } from './listeners/social-notification.listener';
import { NotificationPreferenceRepository } from './repositories/notification-preference.repository';
import { NotificationRepository } from './repositories/notification.repository';
import { NotificationService } from './services/notification.service';
import { PushPolicy } from './services/push.policy';

import { NotificationCenterService } from './services/notification-center.service';
import { NotificationInboxService } from './services/notification-inbox.service';
import { NotificationPreferenceService } from './services/notification-preference.service';
import { NotificationTemplateService } from './services/notification-template.service';
import { NotificationStatisticsService } from './services/notification-statistics.service';
import { NotificationAuditService } from './services/notification-audit.service';
import { NotificationConfigurationService } from './services/notification-configuration.service';
import { NotificationQueryService } from './services/notification-query.service';
import { NotificationChannelService } from './services/notification-channel.service';
import { NotificationDispatchService } from './services/notification-dispatch.service';
import { NotificationValidationService } from './services/notification-validation.service';
import { NotificationEventService } from './services/notification-event.service';

const ENTERPRISE_SERVICES = [
  NotificationCenterService,
  NotificationInboxService,
  NotificationPreferenceService,
  NotificationTemplateService,
  NotificationStatisticsService,
  NotificationAuditService,
  NotificationConfigurationService,
  NotificationQueryService,
  NotificationChannelService,
  NotificationDispatchService,
  NotificationValidationService,
  NotificationEventService,
];

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
  imports: [PrismaModule],
  controllers: [NotificationController, NotificationCenterController],
  providers: [
    // repositories
    NotificationRepository,
    NotificationPreferenceRepository,
    // services
    PushPolicy,
    NotificationService,
    ...ENTERPRISE_SERVICES,
    // listeners
    SocialNotificationListener,
    ChatNotificationListener,
    GiftNotificationListener,
    NotificationSocketListener,
    // public token
    { provide: NOTIFICATION_SERVICE, useExisting: NotificationService },
  ],
  exports: [NOTIFICATION_SERVICE, ...ENTERPRISE_SERVICES],
})
export class NotificationModule {}
