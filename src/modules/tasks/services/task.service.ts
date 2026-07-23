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

    const def = await this.prisma.taskDefinition.create({
      data: {
        code: input.code,
        missionId: input.missionId,
        name: input.name,
        description: input.description,
        category: input.category,
        objective: input.objective,
        requiredProgress: input.requiredProgress ?? 1,
        progressRules: input.progressRules,
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
    const byId = await this.prisma.taskDefinition.findUnique({ where: { id: idOrCode } }).catch(() => null);
    return byId ?? this.prisma.taskDefinition.findUnique({ where: { code: idOrCode } });
  }
}
