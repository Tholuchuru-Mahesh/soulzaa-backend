import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditAction } from '../constants/event.constants';

@Injectable()
export class EventAuditService {
  private readonly logger = new Logger(EventAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logAudit(
    action: EventAuditAction,
    eventId?: string,
    actorId?: string,
    details?: Record<string, any>,
  ) {
    try {
      return await this.prisma.eventAudit.create({
        data: { eventId, actorId, action, details: details ?? {} },
      });
    } catch (err) {
      this.logger.error(`Failed to write event audit ${action}: ${(err as Error).message}`);
    }
  }

  async getLogs(eventId?: string, action?: string, limit = 50, offset = 0) {
    const where: any = {};
    if (eventId) where.eventId = eventId;
    if (action) where.action = action;

    const [items, total] = await Promise.all([
      this.prisma.eventAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.eventAudit.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
