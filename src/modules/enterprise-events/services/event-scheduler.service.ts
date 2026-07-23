import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditService } from './event-audit.service';
import { EventEventService } from './event-event.service';

@Injectable()
export class EventSchedulerService {
  private readonly logger = new Logger(EventSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: EventAuditService,
    private readonly eventService: EventEventService,
  ) {}

  /**
   * Processes all active & scheduled events and updates their lifecycle status based on time windows.
   * Called by background scheduler or manual trigger.
   */
  async processEventSchedules(actorId?: string) {
    const now = new Date();

    // 1. SCHEDULED / DRAFT -> REGISTRATION_OPEN
    const openRegEvents = await this.prisma.eventDefinition.findMany({
      where: {
        status: { in: ['SCHEDULED', 'DRAFT'] },
        regStartTime: { lte: now },
        regEndTime: { gt: now },
      },
    });

    for (const event of openRegEvents) {
      await this.prisma.eventDefinition.update({
        where: { id: event.id },
        data: { status: 'REGISTRATION_OPEN' },
      });
      await this.auditService.logAudit('EVENT_STATUS_CHANGED', event.id, actorId, {
        from: event.status,
        to: 'REGISTRATION_OPEN',
      });
      await this.eventService.publishRegistrationOpened(event.id, event.regEndTime ?? undefined);
    }

    // 2. REGISTRATION_OPEN -> REGISTRATION_CLOSED
    const closeRegEvents = await this.prisma.eventDefinition.findMany({
      where: {
        status: 'REGISTRATION_OPEN',
        regEndTime: { lte: now },
      },
    });

    for (const event of closeRegEvents) {
      const count = await this.prisma.eventRegistration.count({
        where: { eventId: event.id, status: 'REGISTERED' },
      });
      await this.prisma.eventDefinition.update({
        where: { id: event.id },
        data: { status: 'REGISTRATION_CLOSED' },
      });
      await this.auditService.logAudit('EVENT_STATUS_CHANGED', event.id, actorId, {
        from: 'REGISTRATION_OPEN',
        to: 'REGISTRATION_CLOSED',
      });
      await this.eventService.publishRegistrationClosed(event.id, count);
    }

    // 3. REGISTRATION_CLOSED / SCHEDULED -> ACTIVE
    const startEvents = await this.prisma.eventDefinition.findMany({
      where: {
        status: { in: ['REGISTRATION_CLOSED', 'SCHEDULED'] },
        startTime: { lte: now },
        endTime: { gt: now },
      },
    });

    for (const event of startEvents) {
      await this.prisma.eventDefinition.update({
        where: { id: event.id },
        data: { status: 'ACTIVE' },
      });
      await this.auditService.logAudit('EVENT_STARTED', event.id, actorId, {
        startTime: event.startTime,
      });
      await this.eventService.publishEventStarted(event.id, event.startTime);
    }

    // 4. ACTIVE -> COMPLETED
    const completeEvents = await this.prisma.eventDefinition.findMany({
      where: {
        status: 'ACTIVE',
        endTime: { lte: now },
      },
    });

    for (const event of completeEvents) {
      const count = await this.prisma.eventParticipant.count({
        where: { eventId: event.id },
      });
      await this.prisma.eventDefinition.update({
        where: { id: event.id },
        data: { status: 'COMPLETED' },
      });
      await this.auditService.logAudit('EVENT_COMPLETED', event.id, actorId, {
        completedAt: now,
      });
      await this.eventService.publishEventCompleted(event.id, now, count);
    }

    this.logger.log(
      `Event scheduler run complete: RegOpened=${openRegEvents.length}, RegClosed=${closeRegEvents.length}, Started=${startEvents.length}, Completed=${completeEvents.length}`,
    );

    return {
      registrationOpened: openRegEvents.length,
      registrationClosed: closeRegEvents.length,
      started: startEvents.length,
      completed: completeEvents.length,
    };
  }
}
