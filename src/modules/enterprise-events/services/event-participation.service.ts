import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditService } from './event-audit.service';
import { EventValidationService } from './event-validation.service';

@Injectable()
export class EventParticipationService {
  private readonly logger = new Logger(EventParticipationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: EventValidationService,
    private readonly auditService: EventAuditService,
  ) {}

  /**
   * Check in / join an event as an active participant.
   */
  async joinEvent(eventId: string, userId: string, actorId?: string) {
    const event = await this.validationService.validateEventExists(eventId);
    if (event.status !== 'ACTIVE' && event.status !== 'REGISTRATION_OPEN') {
      throw new BadRequestException(`Event ${eventId} is not currently active for participation`);
    }

    const participant = await this.prisma.eventParticipant.upsert({
      where: { eventId_userId: { eventId, userId } },
      update: { status: 'PARTICIPATING', joinedAt: new Date() },
      create: { eventId, userId, status: 'PARTICIPATING' },
    });

    await this.auditService.logAudit('EVENT_PARTICIPATED', eventId, actorId ?? userId, {
      userId,
      status: 'PARTICIPATING',
    });

    return participant;
  }

  /**
   * Update participant score / progress during an event.
   */
  async updateParticipantScore(eventId: string, userId: string, scoreDelta: number) {
    const participant = await this.prisma.eventParticipant.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });

    if (!participant) {
      throw new BadRequestException(`User ${userId} is not a participant in event ${eventId}`);
    }

    const newScore = BigInt(Math.max(0, Number(participant.score) + scoreDelta));

    return this.prisma.eventParticipant.update({
      where: { id: participant.id },
      data: { score: newScore },
    });
  }

  /**
   * Mark participant status as COMPLETED.
   */
  async completeParticipation(eventId: string, userId: string, actorId?: string) {
    const participant = await this.prisma.eventParticipant.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });

    if (!participant) {
      throw new BadRequestException(`User ${userId} is not a participant in event ${eventId}`);
    }

    const updated = await this.prisma.eventParticipant.update({
      where: { id: participant.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    await this.auditService.logAudit('EVENT_PARTICIPATED', eventId, actorId ?? userId, {
      userId,
      status: 'COMPLETED',
    });

    return updated;
  }

  /**
   * Disqualify a participant from an event.
   */
  async disqualifyParticipant(eventId: string, userId: string, reason: string, actorId?: string) {
    const participant = await this.prisma.eventParticipant.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });

    if (!participant) {
      throw new BadRequestException(`User ${userId} is not a participant in event ${eventId}`);
    }

    const updated = await this.prisma.eventParticipant.update({
      where: { id: participant.id },
      data: { status: 'DISQUALIFIED', metadata: { disqualificationReason: reason } },
    });

    await this.auditService.logAudit('EVENT_PARTICIPATED', eventId, actorId, {
      userId,
      status: 'DISQUALIFIED',
      reason,
    });

    return updated;
  }

  async getEventParticipants(eventId: string, status?: string, limit = 100, offset = 0) {
    const where: any = { eventId };
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      this.prisma.eventParticipant.findMany({
        where,
        orderBy: [{ score: 'desc' }, { joinedAt: 'asc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.eventParticipant.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
