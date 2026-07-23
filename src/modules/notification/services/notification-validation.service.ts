import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { NOTIFICATION_CENTER_TYPES, NOTIFICATION_CHANNELS } from '../constants/notification-center.constants';

@Injectable()
export class NotificationValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertRecipientExists(recipientId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: recipientId },
    });
    if (!user) {
      throw new NotFoundException(`Recipient user "${recipientId}" not found.`);
    }
  }

  async assertTemplateExists(code: string): Promise<void> {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { code },
    });
    if (!template) {
      throw new NotFoundException(`Notification template with code "${code}" not found.`);
    }
  }

  assertNotificationTypeValid(type: string): void {
    if (!NOTIFICATION_CENTER_TYPES.includes(type as any)) {
      throw new BadRequestException(`Invalid notification type: "${type}".`);
    }
  }

  assertChannelValid(channel: string): void {
    if (!NOTIFICATION_CHANNELS.includes(channel as any)) {
      throw new BadRequestException(`Invalid notification channel: "${channel}".`);
    }
  }

  async assertBroadcastLimitNotExceeded(limit: number): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const count = await this.prisma.enterpriseNotification.count({
      where: {
        recipientId: null,
        type: 'ANNOUNCEMENT',
        createdAt: { gte: today },
      },
    });

    if (count >= limit) {
      throw new BadRequestException(
        `Daily global broadcast/announcement limit (${limit}) exceeded.`,
      );
    }
  }
}
