import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class EventQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves active & upcoming event schedules.
   */
  async getEventSchedules(category?: string, limit = 50) {
    const now = new Date();
    return this.prisma.eventDefinition.findMany({
      where: {
        ...(category ? { category } : {}),
        status: { in: ['SCHEDULED', 'REGISTRATION_OPEN', 'ACTIVE'] },
        endTime: { gte: now },
      },
      orderBy: { startTime: 'asc' },
      take: limit,
    });
  }

  /**
   * Retrieves user event participation history.
   */
  async getUserEventHistory(userId: string, limit = 50, offset = 0) {
    const [items, total] = await Promise.all([
      this.prisma.eventParticipant.findMany({
        where: { userId },
        include: { event: true },
        orderBy: { joinedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.eventParticipant.count({ where: { userId } }),
    ]);

    return { items, total, limit, offset };
  }

  /**
   * Retrieves events grouped by category.
   */
  async getEventsByCategory(category: string) {
    return this.prisma.eventDefinition.findMany({
      where: { category },
      orderBy: [{ priority: 'desc' }, { startTime: 'desc' }],
    });
  }

  /**
   * Retrieves event history log.
   */
  async getEventHistoryLogs(eventId: string, limit = 50, offset = 0) {
    const [items, total] = await Promise.all([
      this.prisma.eventHistory.findMany({
        where: { eventId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.eventHistory.count({ where: { eventId } }),
    ]);

    return { items, total, limit, offset };
  }
}
