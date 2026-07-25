import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditService } from './event-audit.service';
import { EventEventService } from './event-event.service';
import { EventStatisticsService } from './event-statistics.service';
import { EventValidationService } from './event-validation.service';

export interface CreateEventInput {
  code: string;
  name: string;
  description?: string;
  category: string;
  banner?: string;
  thumbnail?: string;
  startTime: Date;
  endTime: Date;
  regStartTime?: Date;
  regEndTime?: Date;
  participationRules?: Record<string, any>;
  eligibilityRules?: Record<string, any>;
  rewardDefinition?: Record<string, any>;
  maxParticipants?: number;
  visibility?: string;
  country?: string;
  region?: string;
  season?: string;
  priority?: number;
  actorId?: string;
}

export interface UpdateEventInput {
  name?: string;
  description?: string;
  category?: string;
  banner?: string;
  thumbnail?: string;
  startTime?: Date;
  endTime?: Date;
  regStartTime?: Date;
  regEndTime?: Date;
  participationRules?: Record<string, any>;
  eligibilityRules?: Record<string, any>;
  rewardDefinition?: Record<string, any>;
  maxParticipants?: number;
  visibility?: string;
  country?: string;
  region?: string;
  season?: string;
  priority?: number;
  actorId?: string;
}

@Injectable()
export class EventService {
  private readonly logger = new Logger(EventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: EventValidationService,
    private readonly auditService: EventAuditService,
    private readonly eventService: EventEventService,
    private readonly statisticsService: EventStatisticsService,
  ) {}

  async createEvent(input: CreateEventInput) {
    this.validationService.validateCategory(input.category);
    this.validationService.validateTimeWindows(
      input.startTime,
      input.endTime,
      input.regStartTime,
      input.regEndTime,
    );

    const def = await this.prisma.eventDefinition.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description,
        category: input.category,
        banner: input.banner,
        thumbnail: input.thumbnail,
        startTime: input.startTime,
        endTime: input.endTime,
        regStartTime: input.regStartTime,
        regEndTime: input.regEndTime,
        participationRules: input.participationRules,
        eligibilityRules: input.eligibilityRules,
        rewardDefinition: input.rewardDefinition,
        maxParticipants: input.maxParticipants ?? 1000,
        visibility: input.visibility ?? 'PUBLIC',
        country: input.country,
        region: input.region,
        season: input.season,
        priority: input.priority ?? 0,
        status: 'SCHEDULED',
      },
    });

    await this.auditService.logAudit('EVENT_CREATED', def.id, input.actorId, { code: def.code });

    await this.eventService.publishEventCreated(def.id, def.code, def.category);

    return def;
  }

  async updateEvent(id: string, input: UpdateEventInput) {
    await this.validationService.validateEventExists(id);

    if (input.category) this.validationService.validateCategory(input.category);

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        category: input.category,
        banner: input.banner,
        thumbnail: input.thumbnail,
        startTime: input.startTime,
        endTime: input.endTime,
        regStartTime: input.regStartTime,
        regEndTime: input.regEndTime,
        participationRules: input.participationRules,
        eligibilityRules: input.eligibilityRules,
        rewardDefinition: input.rewardDefinition,
        maxParticipants: input.maxParticipants,
        visibility: input.visibility,
        country: input.country,
        region: input.region,
        season: input.season,
        priority: input.priority,
      },
    });

    await this.auditService.logAudit('EVENT_UPDATED', id, input.actorId, { input });

    await this.eventService.publishEventUpdated(id, input as any);

    return updated;
  }

  async updateStatus(id: string, status: string, actorId?: string) {
    await this.validationService.validateEventExists(id);
    this.validationService.validateStatus(status);

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: { status },
    });

    await this.auditService.logAudit('EVENT_STATUS_CHANGED', id, actorId, { status });

    if (status === 'CANCELLED') {
      await this.eventService.publishEventCancelled(id, 'Admin status update');
    }

    return updated;
  }

  async cancelEvent(id: string, reason?: string, actorId?: string) {
    await this.validationService.validateEventExists(id);

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    await this.auditService.logAudit('EVENT_CANCELLED', id, actorId, { reason });

    await this.eventService.publishEventCancelled(id, reason);

    return updated;
  }

  async getEventDefinitions(category?: string, status?: string) {
    return this.prisma.eventDefinition.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ priority: 'desc' }, { startTime: 'asc' }],
    });
  }

  async getEventDefinition(idOrCode: string) {
    const byId = await this.prisma.eventDefinition
      .findUnique({ where: { id: idOrCode } })
      .catch(() => null);
    return byId ?? this.prisma.eventDefinition.findUnique({ where: { code: idOrCode } });
  }
}
