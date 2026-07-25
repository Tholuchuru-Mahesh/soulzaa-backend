import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { NotificationValidationService } from './notification-validation.service';
import { NotificationTemplateService } from './notification-template.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationEventService } from './notification-event.service';
import { NotificationAuditService } from './notification-audit.service';
import { NotificationConfigurationService } from './notification-configuration.service';

export interface SendNotificationInput {
  recipientId?: string; // null for broadcast
  type: string;
  templateCode: string;
  variables: Record<string, string>;
  priority?: string;
  scheduledAt?: Date;
  channels?: string[];
}

@Injectable()
export class NotificationCenterService {
  private readonly logger = new Logger(NotificationCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: NotificationValidationService,
    private readonly templateService: NotificationTemplateService,
    private readonly dispatchService: NotificationDispatchService,
    private readonly events: NotificationEventService,
    private readonly audit: NotificationAuditService,
    private readonly config: NotificationConfigurationService,
  ) {}

  /**
   * Orchestrates the creation and sending of a single notification.
   */
  async send(input: SendNotificationInput): Promise<unknown> {
    // 1. Validate type and templates
    this.validation.assertNotificationTypeValid(input.type);
    await this.validation.assertTemplateExists(input.templateCode);

    if (input.recipientId) {
      await this.validation.assertRecipientExists(input.recipientId);
    } else {
      // Broadcast check limits
      const limit = await this.config.getBroadcastLimit();
      await this.validation.assertBroadcastLimitNotExceeded(limit);
    }

    // 2. Render templates
    const rendered = await this.templateService.renderTemplate(input.templateCode, input.variables);

    // 3. Create Notification record
    const notification = await this.prisma.enterpriseNotification.create({
      data: {
        recipientId: input.recipientId ?? null,
        type: input.type,
        priority: input.priority ?? 'NORMAL',
        title: rendered.title,
        body: rendered.body,
        scheduledAt: input.scheduledAt ?? null,
        status: input.scheduledAt ? 'PENDING' : 'DISPATCHED',
      },
    });

    // Emit domain event for creation
    this.events.emitNotificationCreated({
      notificationId: notification.id,
      recipientId: input.recipientId,
      type: input.type,
      priority: notification.priority,
      title: rendered.title,
      body: rendered.body,
    });

    await this.audit.log({
      action: 'NOTIFICATION_CREATED',
      notificationId: notification.id,
      details: { recipientId: input.recipientId, type: input.type },
    });

    // 4. If scheduled, keep it in PENDING state. Otherwise execute immediately.
    if (!input.scheduledAt) {
      const defaultChannel = await this.config.getDefaultChannel();
      const channels = input.channels ?? [defaultChannel];

      await this.dispatchService.dispatch({
        notificationId: notification.id,
        recipientId: input.recipientId,
        type: input.type,
        title: rendered.title,
        body: rendered.body,
        channels,
      });
    }

    return notification;
  }

  /**
   * Broadcasts a global announcement to all users.
   */
  async broadcastAnnouncement(
    templateCode: string,
    variables: Record<string, string>,
  ): Promise<unknown> {
    const announcement = await this.send({
      type: 'ANNOUNCEMENT',
      templateCode,
      variables,
      priority: 'HIGH',
      channels: ['IN_APP', 'PUSH', 'WEBSOCKET'],
    });

    this.events.emitAnnouncementPublished({
      notificationId: (announcement as any).id,
      type: 'ANNOUNCEMENT',
      title: (announcement as any).title,
      body: (announcement as any).body,
    });

    await this.audit.log({
      action: 'ANNOUNCEMENT_PUBLISHED',
      notificationId: (announcement as any).id,
    });

    return announcement;
  }

  /**
   * Cancels a pending/scheduled notification.
   */
  async cancel(notificationId: string): Promise<void> {
    await this.prisma.enterpriseNotification.update({
      where: { id: notificationId },
      data: { status: 'CANCELLED' },
    });
    this.logger.log(`Notification cancelled: ${notificationId}`);
  }

  /**
   * Purges old notifications matching dynamic retention days configuration.
   */
  async purgeExpired(): Promise<number> {
    const retentionDays = await this.config.getRetentionDays();
    const expiryDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Delete inboxes
    await this.prisma.notificationInbox.deleteMany({
      where: { createdAt: { lt: expiryDate } },
    });

    // Delete history
    await this.prisma.notificationHistory.deleteMany({
      where: { dispatchedAt: { lt: expiryDate } },
    });

    // Delete notifications
    const result = await this.prisma.enterpriseNotification.deleteMany({
      where: { createdAt: { lt: expiryDate } },
    });

    this.logger.log(`Purged ${result.count} expired notifications.`);
    return result.count;
  }
}
