import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EventAuditService } from './event-audit.service';
import { EventEventService } from './event-event.service';
import { EventStatisticsService } from './event-statistics.service';
import { EventValidationService } from './event-validation.service';

export interface EventTaskInput {
  code?: string;
  name: string;
  description?: string;
  objective: string;
  requiredProgress?: number;
  difficulty?: string;
  priority?: number;
  rewardDefinition?: Record<string, any>;
  progressRules?: Record<string, any>;
  completionRules?: Record<string, any>;
}

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
  status?: string;
  actorId?: string;
  tasks?: EventTaskInput[];
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
  status?: string;
  actorId?: string;
  tasks?: EventTaskInput[];
}

@Injectable()
export class EventService implements OnModuleInit {
  private readonly logger = new Logger(EventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: EventValidationService,
    private readonly auditService: EventAuditService,
    private readonly eventService: EventEventService,
    private readonly statisticsService: EventStatisticsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Ensure all event mission task definitions are active for participants
      await this.prisma.taskDefinition.updateMany({
        where: {
          category: 'EVENT_MISSION',
          status: { in: ['DRAFT', 'SCHEDULED'] },
        },
        data: {
          status: 'ACTIVE',
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to auto-activate event mission tasks on startup: ${(err as Error).message}`,
      );
    }
  }

  async createEvent(input: CreateEventInput) {
    console.log('CREATE EVENT INPUT:', JSON.stringify(input, null, 2));
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
        participationRules: input.participationRules as any,
        eligibilityRules: input.eligibilityRules as any,
        rewardDefinition: input.rewardDefinition as any,
        maxParticipants: input.maxParticipants ?? 1000,
        visibility: input.visibility ?? 'PUBLIC',
        country: input.country,
        region: input.region,
        season: input.season,
        priority: input.priority ?? 0,
        status: input.status ?? 'SCHEDULED',
      },
    });

    // If tasks are attached, sync them to TaskDefinition engine
    const rawTasks = input.tasks || (input.participationRules?.tasks as EventTaskInput[]);
    if (rawTasks && rawTasks.length > 0) {
      const taskStatus =
        input.status === 'CANCELLED' || input.status === 'DRAFT' ? 'DRAFT' : 'ACTIVE';
      await this.syncEventTasks(def, rawTasks, taskStatus, input.actorId);
    }

    await this.auditService.logAudit('EVENT_CREATED', def.id, input.actorId, { code: def.code });
    await this.eventService.publishEventCreated(def.id, def.code, def.category);

    return this.enrichEventWithTasks(def);
  }

  async updateEvent(id: string, input: UpdateEventInput) {
    await this.validationService.validateEventExists(id);

    if (input.category) this.validationService.validateCategory(input.category);

    const existing = await this.prisma.eventDefinition.findUnique({ where: { id } });
    const existingRules = (existing?.participationRules as Record<string, any>) || {};

    const mergedRules = {
      ...existingRules,
      ...(input.participationRules || {}),
      ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
    };

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
        participationRules: mergedRules as any,
        eligibilityRules: input.eligibilityRules as any,
        rewardDefinition: input.rewardDefinition as any,
        maxParticipants: input.maxParticipants,
        visibility: input.visibility,
        country: input.country,
        region: input.region,
        season: input.season,
        priority: input.priority,
      },
    });

    const rawTasks = input.tasks || (mergedRules?.tasks as EventTaskInput[]);
    if (rawTasks) {
      const taskStatus =
        updated.status === 'CANCELLED' || updated.status === 'DRAFT' ? 'DRAFT' : 'ACTIVE';
      await this.syncEventTasks(updated, rawTasks, taskStatus, input.actorId);
    }

    await this.auditService.logAudit('EVENT_UPDATED', id, input.actorId, { input });
    await this.eventService.publishEventUpdated(id, input as any);

    return this.enrichEventWithTasks(updated);
  }

  async updateStatus(id: string, status: string, actorId?: string) {
    await this.validationService.validateEventExists(id);
    this.validationService.validateStatus(status);

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: { status },
    });

    // Synchronize attached tasks with new event status
    const rules = updated.participationRules as Record<string, any> | null;
    const tasks = (rules?.tasks as EventTaskInput[]) || [];

    if (status === 'APPROVED' || status === 'ACTIVE') {
      // Activate all tasks in the generic task engine
      await this.syncEventTasks(updated, tasks, 'ACTIVE', actorId);
    } else if (status === 'CANCELLED' || status === 'REJECTED') {
      // Cancel/deactivate attached tasks
      await this.syncEventTasks(updated, tasks, 'CANCELLED', actorId);
    }

    await this.auditService.logAudit('EVENT_STATUS_CHANGED', id, actorId, { status });

    if (status === 'CANCELLED') {
      await this.eventService.publishEventCancelled(id, 'Admin status update');
    } else {
      await this.eventService.publishEventUpdated(id, { status });
    }

    return this.enrichEventWithTasks(updated);
  }

  async cancelEvent(id: string, reason?: string, actorId?: string) {
    await this.validationService.validateEventExists(id);

    const updated = await this.prisma.eventDefinition.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    const rules = updated.participationRules as Record<string, any> | null;
    const tasks = (rules?.tasks as EventTaskInput[]) || [];
    await this.syncEventTasks(updated, tasks, 'CANCELLED', actorId);

    await this.auditService.logAudit('EVENT_CANCELLED', id, actorId, { reason });
    await this.eventService.publishEventCancelled(id, reason);

    return this.enrichEventWithTasks(updated);
  }

  async getEventDefinitions(category?: string, status?: string) {
    // When status='ACTIVE' (or similar user-facing request), return active/approved/scheduled.
    // When no status or explicit status provided, use that filter directly.
    const statusFilter =
      status === 'ACTIVE'
        ? { in: ['ACTIVE', 'APPROVED', 'SCHEDULED'] }
        : status
          ? { in: [status] }
          : undefined;

    const events = await this.prisma.eventDefinition.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      },
      orderBy: [{ priority: 'desc' }, { startTime: 'asc' }],
    });

    // For user-facing requests (status=ACTIVE), only return active tasks.
    // For admin requests (any other status or no status), return all tasks.
    const enrichFn =
      status === 'ACTIVE'
        ? (e: any) => this.enrichEventWithTasksFiltered(e)
        : (e: any) => this.enrichEventWithTasks(e);

    return Promise.all(events.map(enrichFn));
  }

  /**
   * Admin/super-admin: list ALL events regardless of status (for the portal).
   * Returns all tasks including DRAFT ones so admins can inspect the full proposal.
   */
  async getAllEventDefinitions(category?: string, status?: string) {
    const events = await this.prisma.eventDefinition.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ priority: 'desc' }, { startTime: 'asc' }],
    });

    return Promise.all(events.map((e) => this.enrichEventWithTasks(e)));
  }

  /**
   * User-facing: events currently live (status ACTIVE) and in scope for this
   * user's location. An event with a null countryId/regionId is global; one
   * with a value only matches users whose own location resolves to it. This
   * is the read path the audio-room "Event" entry point calls — no RBAC
   * permission is required, unlike the admin-facing endpoints above.
   */
  async getActiveEventsForUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { countryId: true, regionId: true },
    });

    const countryFilter = user?.countryId
      ? [{ countryId: null }, { countryId: user.countryId }]
      : [{ countryId: null }];
    const regionFilter = user?.regionId
      ? [{ regionId: null }, { regionId: user.regionId }]
      : [{ regionId: null }];

    const events = await this.prisma.eventDefinition.findMany({
      where: {
        status: 'ACTIVE',
        AND: [{ OR: countryFilter }, { OR: regionFilter }],
      },
      orderBy: [{ priority: 'desc' }, { startTime: 'asc' }],
    });

    return Promise.all(events.map((e) => this.enrichEventWithTasksFiltered(e)));
  }

  async getEventDefinition(idOrCode: string) {
    const byId = await this.prisma.eventDefinition
      .findUnique({ where: { id: idOrCode } })
      .catch(() => null);
    const event =
      byId ?? (await this.prisma.eventDefinition.findUnique({ where: { code: idOrCode } }));
    if (!event) return null;
    return this.enrichEventWithTasks(event);
  }

  /**
   * Synchronizes event task definitions with the generic TaskDefinition engine.
   * Enables task execution and reward dispatching without duplicate models.
   */
  private async syncEventTasks(
    event: { id: string; code: string; name: string; startTime: Date; endTime: Date },
    tasks: EventTaskInput[],
    targetStatus: string,
    // Accepted so the signature matches every other write on this service, and
    // because an audit entry here would need it. Unused today.
    _actorId?: string,
  ) {
    if (!tasks || tasks.length === 0) {
      // If tasks is empty, but tasks already existed in TaskDefinition with this event prefix, update their status
      await this.prisma.taskDefinition.updateMany({
        where: { code: { startsWith: `${event.code}_TASK_` } },
        data: { status: targetStatus },
      });
      return;
    }

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const taskCode = t.code || `${event.code}_TASK_${i + 1}`;
      const progressRules = t.progressRules || {
        eventCodes: [t.objective || 'STREAM_WATCH'],
        operator: 'ANY',
        eventId: event.id,
      };

      try {
        await this.prisma.taskDefinition.upsert({
          where: { code: taskCode },
          update: {
            name: t.name,
            description: t.description || `${event.name} Event Task`,
            category: 'EVENT_MISSION',
            objective: t.objective || 'STREAM_WATCH',
            requiredProgress: t.requiredProgress ?? 1,
            difficulty: t.difficulty ?? 'EASY',
            priority: t.priority ?? 0,
            rewardDefinition: t.rewardDefinition || {},
            progressRules,
            completionRules: t.completionRules || {},
            startTime: event.startTime,
            endTime: event.endTime,
            resetPolicy: 'NONE',
            repeatable: false,
            status: targetStatus,
          },
          create: {
            code: taskCode,
            name: t.name,
            description: t.description || `${event.name} Event Task`,
            category: 'EVENT_MISSION',
            objective: t.objective || 'STREAM_WATCH',
            requiredProgress: t.requiredProgress ?? 1,
            difficulty: t.difficulty ?? 'EASY',
            priority: t.priority ?? 0,
            rewardDefinition: t.rewardDefinition || {},
            progressRules,
            completionRules: t.completionRules || {},
            startTime: event.startTime,
            endTime: event.endTime,
            resetPolicy: 'NONE',
            repeatable: false,
            status: targetStatus,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Failed to upsert task definition ${taskCode} for event ${event.code}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Enriches an event object with its tasks from TaskDefinition or participationRules.
   * Returns all tasks regardless of status (used by admin/super-admin portals).
   */
  private async enrichEventWithTasks(event: any) {
    const rules = event.participationRules as Record<string, any> | null;
    let tasks = (rules?.tasks as EventTaskInput[]) || [];

    // Also look up synced task definitions in TaskDefinition table
    const taskDefinitions = await this.prisma.taskDefinition.findMany({
      where: {
        OR: [
          { code: { startsWith: `${event.code}_TASK_` } },
          ...(tasks.map((t) => (t.code ? { code: t.code } : null)).filter(Boolean) as any),
        ],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    if (taskDefinitions.length > 0) {
      tasks = taskDefinitions.map((td) => ({
        id: td.id,
        code: td.code,
        name: td.name,
        description: td.description ?? undefined,
        objective: td.objective,
        requiredProgress: td.requiredProgress,
        difficulty: td.difficulty,
        priority: td.priority,
        rewardDefinition: (td.rewardDefinition as Record<string, any>) ?? {},
        progressRules: (td.progressRules as Record<string, any>) ?? {},
        completionRules: (td.completionRules as Record<string, any>) ?? {},
        status: td.status,
      }));
    }

    return {
      ...event,
      tasks,
    };
  }

  /**
   * Same as enrichEventWithTasks but only returns ACTIVE tasks.
   * Used for the user-facing mobile app so only launched tasks are visible.
   */
  private async enrichEventWithTasksFiltered(event: any) {
    const enriched = await this.enrichEventWithTasks(event);
    // Only surface tasks that have been activated (approved/launched)
    const activeTasks = (enriched.tasks as any[]).filter((t) => !t.status || t.status === 'ACTIVE');
    return { ...enriched, tasks: activeTasks };
  }
}
