import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { NotificationChannelService } from './notification-channel.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationStatisticsService } from './notification-statistics.service';
import { NotificationEventService } from './notification-event.service';
import { NotificationAuditService } from './notification-audit.service';
import { NotificationConfigurationService } from './notification-configuration.service';

export interface DispatchInput {
  notificationId: string;
  recipientId?: string;
  type: string;
  title: string;
  body: string;
  channels: string[];
}

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channelsService: NotificationChannelService,
    private readonly preference: NotificationPreferenceService,
    private readonly statistics: NotificationStatisticsService,
    private readonly events: NotificationEventService,
    private readonly audit: NotificationAuditService,
    private readonly config: NotificationConfigurationService,
  ) {}

  /**
   * Dispatches a notification across specified channels.
   * Honoures user opt-out preferences and logs delivery histories.
   */
  async dispatch(input: DispatchInput): Promise<void> {
    const maxRetry = await this.config.getRetryCount();

    for (const channel of input.channels) {
      // 1. Honoure user preferences for targeted recipient
      if (input.recipientId) {
        const allowed = await this.preference.isEnabled(input.recipientId, input.type, channel);
        if (!allowed) {
          this.logger.log(
            `Skipped channel [${channel}] for user: ${input.recipientId} due to preferences restriction.`,
          );
          continue;
        }
      }

      // 2. If in-app, write to the User Inbox model directly
      if (channel === 'IN_APP' && input.recipientId) {
        await this.prisma.notificationInbox.create({
          data: {
            notificationId: input.notificationId,
            recipientId: input.recipientId,
            title: input.title,
            body: input.body,
          },
        });
      }

      // 3. Execution logic using channel handlers
      const result = await this.channelsService.dispatchToChannel(channel, {
        notificationId: input.notificationId,
        recipientId: input.recipientId,
        title: input.title,
        body: input.body,
      });

      if (result.success) {
        // Create history log
        await this.prisma.notificationHistory.create({
          data: {
            notificationId: input.notificationId,
            recipientId: input.recipientId ?? null,
            channel,
            status: 'SENT',
          },
        });

        // Increment stats
        await this.statistics.incrementStat(channel, 'sentCount');

        // Emit sent domain event
        this.events.emitNotificationSent({
          notificationId: input.notificationId,
          recipientId: input.recipientId,
          channel,
        });

        await this.audit.log({
          action: 'NOTIFICATION_SENT',
          notificationId: input.notificationId,
          details: { channel, recipientId: input.recipientId },
        });
      } else {
        // Failed path: log history with error message
        await this.prisma.notificationHistory.create({
          data: {
            notificationId: input.notificationId,
            recipientId: input.recipientId ?? null,
            channel,
            status: 'FAILED',
            errorMessage: result.errorMessage,
          },
        });

        await this.statistics.incrementStat(channel, 'failedCount');

        this.events.emitNotificationFailed({
          notificationId: input.notificationId,
          recipientId: input.recipientId,
          channel,
          errorMessage: result.errorMessage,
        });

        await this.audit.log({
          action: 'NOTIFICATION_FAILED',
          notificationId: input.notificationId,
          details: { channel, error: result.errorMessage },
        });

        // Simple mock of retry logic queue if failed
        await this.retryQueue(input.notificationId, channel, result.errorMessage ?? 'Unknown', maxRetry);
      }
    }
  }

  async retryQueue(
    notificationId: string,
    channel: string,
    error: string,
    maxRetry: number,
  ): Promise<void> {
    const notification = await this.prisma.enterpriseNotification.findUnique({
      where: { id: notificationId },
    });
    if (notification && notification.retryCount < maxRetry) {
      const nextCount = notification.retryCount + 1;
      this.logger.log(`Retrying dispatch for ${notificationId} (${nextCount}/${maxRetry})`);
      await this.prisma.enterpriseNotification.update({
        where: { id: notificationId },
        data: { retryCount: nextCount },
      });
      // In production, this would register a scheduled delay queue
    }
  }
}
