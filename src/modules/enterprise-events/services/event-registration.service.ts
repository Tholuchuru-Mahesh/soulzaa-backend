import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditService } from './event-audit.service';
import { EventEligibilityService } from './event-eligibility.service';
import { EventEventService } from './event-event.service';
import { EventValidationService } from './event-validation.service';

@Injectable()
export class EventRegistrationService {
  private readonly logger = new Logger(EventRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: EventValidationService,
    private readonly eligibilityService: EventEligibilityService,
    private readonly auditService: EventAuditService,
    private readonly eventService: EventEventService,
  ) {}

  /**
   * Registers a user for an event after passing all eligibility, capacity, and window checks.
   */
  async registerUser(eventId: string, userId: string, actorId?: string) {
    await this.validationService.validateUserExists(userId);
    const event = await this.validationService.validateEventExists(eventId);

    await this.validationService.validateRegistrationWindow(event);
    await this.validationService.validateCapacity(eventId, event.maxParticipants);
    await this.validationService.validateNotAlreadyRegistered(eventId, userId);

    const eligibility = await this.eligibilityService.checkEligibility(userId, eventId);
    if (!eligibility.eligible) {
      throw new BadRequestException(
        `User ${userId} is not eligible: ${eligibility.reasons.join('; ')}`,
      );
    }

    const reg = await this.prisma.eventRegistration.upsert({
      where: { eventId_userId: { eventId, userId } },
      update: { status: 'REGISTERED', registeredAt: new Date() },
      create: { eventId, userId, status: 'REGISTERED' },
    });

    await this.auditService.logAudit('EVENT_REGISTERED', eventId, actorId ?? userId, { userId });

    this.logger.log(`User ${userId} registered for event ${eventId}`);

    return reg;
  }

  /**
   * Unregisters a user from an event.
   */
  async unregisterUser(eventId: string, userId: string, actorId?: string) {
    await this.validationService.validateEventExists(eventId);

    const reg = await this.prisma.eventRegistration.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });

    if (!reg || reg.status !== 'REGISTERED') {
      throw new BadRequestException(
        `User ${userId} is not actively registered for event ${eventId}`,
      );
    }

    const updated = await this.prisma.eventRegistration.update({
      where: { id: reg.id },
      data: { status: 'CANCELLED' },
    });

    await this.auditService.logAudit('EVENT_UNREGISTERED', eventId, actorId ?? userId, { userId });

    return updated;
  }

  async getEventRegistrations(eventId: string, limit = 100, offset = 0) {
    const [items, total] = await Promise.all([
      this.prisma.eventRegistration.findMany({
        where: { eventId, status: 'REGISTERED' },
        orderBy: { registeredAt: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.eventRegistration.count({ where: { eventId, status: 'REGISTERED' } }),
    ]);

    return { items, total, limit, offset };
  }

  async getUserRegistrations(userId: string) {
    return this.prisma.eventRegistration.findMany({
      where: { userId, status: 'REGISTERED' },
      include: { event: true },
      orderBy: { registeredAt: 'desc' },
    });
  }
}
