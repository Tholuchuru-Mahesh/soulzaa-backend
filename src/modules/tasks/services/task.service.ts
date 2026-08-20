import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskAuditService } from './task-audit.service';
import { TaskEventService } from './task-event.service';
import { TaskValidationService } from './task-validation.service';

export interface CreateTaskInput {
  code: string;
  missionId?: string;
  name: string;
  description?: string;
  category: string;
  objective: string;
  requiredProgress?: number;
  eventCode?: string;
  incrementField?: string;
  progressRules?: Record<string, any>;
  completionRules?: Record<string, any>;
  rewardDefinition?: Record<string, any>;
  visibility?: string;
  priority?: number;
  difficulty?: string;
  startTime?: Date;
  endTime?: Date;
  repeatable?: boolean;
  resetPolicy?: string;
  maxCompletions?: number;
  actorId?: string;
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: TaskValidationService,
    private readonly auditService: TaskAuditService,
    private readonly eventService: TaskEventService,
  ) {}

  async createTask(input: CreateTaskInput) {
    this.validationService.validateCategory(input.category);
    if (input.resetPolicy) this.validationService.validateResetPolicy(input.resetPolicy);
    if (input.difficulty) this.validationService.validateDifficulty(input.difficulty);
    if (input.missionId) await this.validationService.validateMissionExists(input.missionId);

    // Build structured progressRules from explicit event trigger configurations
    const progressRules: Record<string, any> = { ...(input.progressRules || {}) };
    if (input.eventCode) {
      progressRules.eventCodes = Array.from(
        new Set([...(progressRules.eventCodes || []), input.eventCode.toLowerCase(), input.eventCode]),
      );
    }
    if (input.incrementField) {
      progressRules.incrementField = input.incrementField;
    }

    const def = await this.prisma.taskDefinition.create({
      data: {
        code: input.code,
        missionId: input.missionId,
        name: input.name,
        description: input.description,
        category: input.category,
        objective: input.objective,
        requiredProgress: input.requiredProgress ?? 1,
        progressRules: Object.keys(progressRules).length > 0 ? progressRules : undefined,
        completionRules: input.completionRules,
        rewardDefinition: input.rewardDefinition,
        visibility: input.visibility ?? 'PUBLIC',
        priority: input.priority ?? 0,
        difficulty: input.difficulty ?? 'EASY',
        startTime: input.startTime,
        endTime: input.endTime,
        repeatable: input.repeatable ?? false,
        resetPolicy: input.resetPolicy ?? 'DAILY',
        maxCompletions: input.maxCompletions ?? 1,
        status: 'ACTIVE',
      },
    });

    await this.auditService.logAudit('TASK_CREATED', def.id, input.actorId, { code: def.code });

    return def;
  }

  async updateTaskStatus(id: string, status: string, actorId?: string) {
    await this.validationService.validateTaskExists(id);
    this.validationService.validateStatus(status);

    const updated = await this.prisma.taskDefinition.update({
      where: { id },
      data: { status },
    });

    await this.auditService.logAudit('TASK_UPDATED', id, actorId, { status });

    if (status === 'EXPIRED') {
      await this.eventService.publishTaskExpired(id, 'Status update to EXPIRED');
    }

    return updated;
  }

  async updateTask(id: string, input: Partial<CreateTaskInput> & { status?: string }) {
    await this.validationService.validateTaskExists(id);

    const existing = await this.prisma.taskDefinition.findUnique({ where: { id } });
    if (!existing) return null;

    const progressRules: Record<string, any> = {
      ...((existing.progressRules as Record<string, any>) || {}),
      ...(input.progressRules || {}),
    };

    if (input.eventCode) {
      progressRules.eventCodes = Array.from(
        new Set([...(progressRules.eventCodes || []), input.eventCode.toLowerCase(), input.eventCode]),
      );
    }
    if (input.incrementField !== undefined) {
      if (input.incrementField) {
        progressRules.incrementField = input.incrementField;
      } else {
        delete progressRules.incrementField;
      }
    }

    const updated = await this.prisma.taskDefinition.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.requiredProgress !== undefined ? { requiredProgress: input.requiredProgress } : {}),
        ...(Object.keys(progressRules).length > 0 ? { progressRules } : {}),
        ...(input.completionRules !== undefined ? { completionRules: input.completionRules } : {}),
        ...(input.rewardDefinition !== undefined ? { rewardDefinition: input.rewardDefinition } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
        ...(input.resetPolicy !== undefined ? { resetPolicy: input.resetPolicy } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });

    await this.auditService.logAudit('TASK_UPDATED', id, input.actorId, {
      name: updated.name,
      code: updated.code,
    });

    return updated;
  }

  async seedDefaultTasks(): Promise<{ count: number }> {
    const DEFAULT_TASKS = [
      {
        code: 'DAILY_LOGIN',
        name: 'Daily Attendance Login',
        category: 'DAILY_TASK',
        objective: 'Log in to Soulzaa to maintain your daily streak',
        requiredProgress: 1,
        eventCode: 'user.logged_in',
        resetPolicy: 'DAILY',
        difficulty: 'EASY',
        rewardDefinition: { freeCoins: 100, exp: 50 },
      },
      {
        code: 'JOIN_ROOMS_DAILY',
        name: 'Join 2 Live Rooms',
        category: 'DAILY_TASK',
        objective: 'Join 2 audio or video rooms today',
        requiredProgress: 2,
        eventCode: 'audio_room.joined',
        resetPolicy: 'DAILY',
        difficulty: 'EASY',
        rewardDefinition: { freeCoins: 200, exp: 100 },
      },
      {
        code: 'ROOM_STAY_20MIN',
        name: 'Stay 20 Minutes in Room',
        category: 'DAILY_TASK',
        objective: 'Spend 20 minutes hanging out in live voice or video rooms',
        requiredProgress: 20,
        eventCode: 'room.duration_updated',
        incrementField: 'durationMinutes',
        resetPolicy: 'DAILY',
        difficulty: 'MEDIUM',
        rewardDefinition: { freeCoins: 500, exp: 250, frameId: 'frame-bronze' },
      },
      {
        code: 'RECHARGE_COINS_DAILY',
        name: 'Coin Recharge Quest',
        category: 'DAILY_TASK',
        objective: 'Recharge or receive 500 coins today',
        requiredProgress: 500,
        eventCode: 'wallet.credited',
        incrementField: 'amount',
        resetPolicy: 'DAILY',
        difficulty: 'MEDIUM',
        rewardDefinition: { freeCoins: 1000, exp: 500, goldCoins: 50 },
      },
      {
        code: 'SEND_GIFTS_DAILY',
        name: 'Send 3 Virtual Gifts',
        category: 'DAILY_TASK',
        objective: 'Send 3 gifts to hosts or friends in live rooms',
        requiredProgress: 3,
        eventCode: 'gift.sent',
        resetPolicy: 'DAILY',
        difficulty: 'MEDIUM',
        rewardDefinition: { freeCoins: 300, exp: 150, themeId: 'theme-neon' },
      },
      {
        code: 'RECEIVE_GIFTS_DAILY',
        name: 'Receive 2 Virtual Gifts',
        category: 'DAILY_TASK',
        objective: 'Receive 2 gifts from audience or friends in room',
        requiredProgress: 2,
        eventCode: 'gift.received',
        resetPolicy: 'DAILY',
        difficulty: 'MEDIUM',
        rewardDefinition: { freeCoins: 400, exp: 200, badgeId: 'badge-star-host' },
      },
      {
        code: 'ADD_FRIENDS_WEEKLY',
        name: 'Add 2 New Friends',
        category: 'WEEKLY_MISSION',
        objective: 'Connect and add 2 new friends on Soulzaa',
        requiredProgress: 2,
        eventCode: 'social.friend.accepted',
        resetPolicy: 'WEEKLY',
        difficulty: 'EASY',
        rewardDefinition: { freeCoins: 1000, exp: 500, bubbleId: 'bubble-stars' },
      },
      {
        code: 'FOLLOW_CREATORS_WEEKLY',
        name: 'Follow 3 Creators',
        category: 'WEEKLY_MISSION',
        objective: 'Follow 3 hosts or creators on the platform',
        requiredProgress: 3,
        eventCode: 'social.followed',
        resetPolicy: 'WEEKLY',
        difficulty: 'EASY',
        rewardDefinition: { freeCoins: 600, exp: 300 },
      },
      {
        code: 'PLAY_GAMES_DAILY',
        name: 'Play 2 Mini-Games',
        category: 'DAILY_TASK',
        objective: 'Participate in 2 games (Lucky Fruit, Casino, etc.)',
        requiredProgress: 2,
        eventCode: 'game.settled',
        resetPolicy: 'DAILY',
        difficulty: 'EASY',
        rewardDefinition: { freeCoins: 500, exp: 250 },
      },
      {
        code: 'FAMILY_QUEST_WEEKLY',
        name: 'Family Community Quest',
        category: 'WEEKLY_MISSION',
        objective: 'Engage with your family or welcome a new member',
        requiredProgress: 1,
        eventCode: 'family.member_joined',
        resetPolicy: 'WEEKLY',
        difficulty: 'HARD',
        rewardDefinition: { freeCoins: 1500, exp: 800, entranceEffectId: 'ride-sports-car' },
      },
    ];

    let count = 0;
    for (const t of DEFAULT_TASKS) {
      const progressRules: Record<string, any> = {
        eventCodes: [t.eventCode.toLowerCase(), t.eventCode],
        ...(t.incrementField ? { incrementField: t.incrementField } : {}),
        operator: 'ANY',
      };

      await this.prisma.taskDefinition.upsert({
        where: { code: t.code },
        update: {
          name: t.name,
          category: t.category,
          objective: t.objective,
          requiredProgress: t.requiredProgress,
          resetPolicy: t.resetPolicy,
          difficulty: t.difficulty,
          status: 'ACTIVE',
          progressRules,
          rewardDefinition: t.rewardDefinition,
        },
        create: {
          code: t.code,
          name: t.name,
          category: t.category,
          objective: t.objective,
          requiredProgress: t.requiredProgress,
          resetPolicy: t.resetPolicy,
          difficulty: t.difficulty,
          status: 'ACTIVE',
          visibility: 'PUBLIC',
          priority: 10,
          repeatable: true,
          maxCompletions: 1,
          progressRules,
          rewardDefinition: t.rewardDefinition,
        },
      });
      count++;
    }

    return { count };
  }

  async getTaskDefinitions(category?: string, status?: string) {
    return this.prisma.taskDefinition.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(status ? { status } : { status: 'ACTIVE' }),
      },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });
  }

  async getTaskDefinition(idOrCode: string) {
    const byId = await this.prisma.taskDefinition
      .findUnique({ where: { id: idOrCode } })
      .catch(() => null);
    return byId ?? this.prisma.taskDefinition.findUnique({ where: { code: idOrCode } });
  }
}
