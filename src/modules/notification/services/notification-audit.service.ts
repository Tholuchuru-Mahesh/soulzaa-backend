import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { NOTIFICATION_AUDIT_ACTIONS, NotificationAuditAction } from '../constants/notification-center.constants';

export interface AuditEntry {
  action: NotificationAuditAction;
  notificationId?: string;
  actorId?: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class NotificationAuditService {
  private readonly logger = new Logger(NotificationAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.notificationAudit.create({
      data: {
        action: entry.action,
        notificationId: entry.notificationId ?? null,
        actorId: entry.actorId ?? null,
        details: (entry.details ?? {}) as any,
      },
    });
    this.logger.log(`Audit [${entry.action}] — notification: ${entry.notificationId ?? 'N/A'}`);
  }

  async queryByAction(
    action: NotificationAuditAction,
    limit = 100,
  ): Promise<unknown[]> {
    return this.prisma.notificationAudit.findMany({
      where: { action },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async queryByNotification(notificationId: string): Promise<unknown[]> {
    return this.prisma.notificationAudit.findMany({
      where: { notificationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAll(skip = 0, take = 100): Promise<unknown[]> {
    return this.prisma.notificationAudit.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  getSupportedActions(): string[] {
    return [...NOTIFICATION_AUDIT_ACTIONS];
  }
}
