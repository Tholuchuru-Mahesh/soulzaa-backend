import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class NotificationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getNotificationDetails(id: string): Promise<unknown> {
    return this.prisma.enterpriseNotification.findUnique({
      where: { id },
      include: {
        inboxes: true,
        histories: true,
      },
    });
  }

  async getRecipientHistory(recipientId: string, skip = 0, take = 50): Promise<unknown[]> {
    return this.prisma.enterpriseNotification.findMany({
      where: { recipientId },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async getDeliveryLogs(notificationId: string): Promise<unknown[]> {
    return this.prisma.notificationHistory.findMany({
      where: { notificationId },
      orderBy: { dispatchedAt: 'desc' },
    });
  }

  async getTemplates(skip = 0, take = 50): Promise<unknown[]> {
    return this.prisma.notificationTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async getPendingNotifications(): Promise<unknown[]> {
    return this.prisma.enterpriseNotification.findMany({
      where: { status: 'PENDING', scheduledAt: { lte: new Date() } },
    });
  }
}
