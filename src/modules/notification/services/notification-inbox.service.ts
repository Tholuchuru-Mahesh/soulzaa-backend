import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { NotificationEventService } from './notification-event.service';
import { NotificationStatisticsService } from './notification-statistics.service';
import { NotificationAuditService } from './notification-audit.service';

@Injectable()
export class NotificationInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: NotificationEventService,
    private readonly stats: NotificationStatisticsService,
    private readonly audit: NotificationAuditService,
  ) {}

  async getInbox(recipientId: string, page = 1, limit = 50): Promise<unknown[]> {
    return this.prisma.notificationInbox.findMany({
      where: { recipientId, deleted: false },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async markAsRead(id: string, recipientId: string): Promise<unknown> {
    const inboxItem = await this.prisma.notificationInbox.findFirst({
      where: { id, recipientId },
    });
    if (!inboxItem) {
      throw new NotFoundException(`Inbox item "${id}" not found.`);
    }

    const updated = await this.prisma.notificationInbox.update({
      where: { id },
      data: { read: true, readAt: new Date() },
    });

    this.events.emitNotificationRead({
      notificationId: inboxItem.notificationId,
      recipientId,
    });

    await this.stats.incrementStat('IN_APP', 'readCount');

    await this.audit.log({
      action: 'NOTIFICATION_READ',
      notificationId: inboxItem.notificationId,
      actorId: recipientId,
    });

    return updated;
  }

  async softDelete(id: string, recipientId: string): Promise<unknown> {
    const inboxItem = await this.prisma.notificationInbox.findFirst({
      where: { id, recipientId },
    });
    if (!inboxItem) {
      throw new NotFoundException(`Inbox item "${id}" not found.`);
    }

    const updated = await this.prisma.notificationInbox.update({
      where: { id },
      data: { deleted: true, deletedAt: new Date() },
    });

    this.events.emitNotificationDeleted({
      notificationId: inboxItem.notificationId,
      recipientId,
    });

    await this.audit.log({
      action: 'NOTIFICATION_DELETED',
      notificationId: inboxItem.notificationId,
      actorId: recipientId,
    });

    return updated;
  }

  async getUnreadCount(recipientId: string): Promise<number> {
    return this.prisma.notificationInbox.count({
      where: { recipientId, read: false, deleted: false },
    });
  }
}
