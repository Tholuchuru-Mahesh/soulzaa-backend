import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskAuditService } from './task-audit.service';
import { TaskEventService as InternalTaskEventService } from './task-event.service';

export interface IncrementProgressInput {
  userId: string;
  taskId: string;
  requiredProgress: number;
  incrementBy?: number;
  resetPolicy?: string;
  eventCode: string;
  metadata?: Record<string, any>;
}

export interface ProgressResult {
  progressBefore: number;
  progressAfter: number;
  requiredProgress: number;
  percentComplete: number;
  justCompleted: boolean;
  isCompleted: boolean;
  completionCount: number;
}

@Injectable()
export class TaskProgressService {
  private readonly logger = new Logger(TaskProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: TaskAuditService,
    private readonly eventService: InternalTaskEventService,
  ) {}

  async incrementProgress(input: IncrementProgressInput): Promise<ProgressResult> {
    const {
      userId,
      taskId,
      requiredProgress,
      incrementBy = 1,
      resetPolicy = 'DAILY',
      eventCode,
      metadata,
    } = input;

    const periodKey = this.buildPeriodKey(resetPolicy);

    const existing = await this.prisma.taskProgress.findUnique({
      where: { taskId_userId_periodKey: { taskId, userId, periodKey } },
    });

    const progressBefore = existing?.currentProgress ?? 0;

    // If already completed for this period, do not increment further
    if (existing?.isCompleted) {
      return {
        progressBefore,
        progressAfter: progressBefore,
        requiredProgress,
        percentComplete: 100,
        justCompleted: false,
        isCompleted: true,
        completionCount: existing.completionCount,
      };
    }

    const progressAfter = Math.min(requiredProgress, progressBefore + incrementBy);
    const percentComplete =
      requiredProgress > 0
        ? Math.min(100, Math.round((progressAfter / requiredProgress) * 100 * 100) / 100)
        : 100;
    const justCompleted = progressBefore < requiredProgress && progressAfter >= requiredProgress;
    const isCompleted = progressAfter >= requiredProgress;
    const completionCount = (existing?.completionCount ?? 0) + (justCompleted ? 1 : 0);

    const _record = await this.prisma.taskProgress.upsert({
      where: { taskId_userId_periodKey: { taskId, userId, periodKey } },
      update: {
        currentProgress: progressAfter,
        percentComplete,
        isCompleted,
        completionCount,
        completedAt: justCompleted ? new Date() : existing?.completedAt,
        updatedAt: new Date(),
      },
      create: {
        taskId,
        userId,
        periodKey,
        currentProgress: progressAfter,
        requiredProgress,
        percentComplete,
        isCompleted,
        completionCount: justCompleted ? 1 : 0,
        completedAt: justCompleted ? new Date() : null,
      },
    });

    // Write immutable history row
    await this.prisma.taskHistory.create({
      data: {
        taskId,
        userId,
        eventCode,
        progressBefore,
        progressAfter,
        completed: justCompleted,
        metadata: metadata ?? {},
      },
    });

    // Publish event
    await this.eventService.publishTaskProgressUpdated(
      taskId,
      userId,
      progressAfter,
      requiredProgress,
      percentComplete,
    );

    if (justCompleted) {
      await this.eventService.publishTaskCompleted(taskId, userId, completionCount);
    }

    return {
      progressBefore,
      progressAfter,
      requiredProgress,
      percentComplete,
      justCompleted,
      isCompleted,
      completionCount,
    };
  }

  async getUserProgress(userId: string, taskId?: string) {
    return this.prisma.taskProgress.findMany({
      where: { userId, ...(taskId ? { taskId } : {}) },
      include: { task: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  buildPeriodKey(resetPolicy: string): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');

    switch (resetPolicy) {
      case 'DAILY':
        return `${y}${m}${d}`;
      case 'WEEKLY': {
        const w = this.isoWeek(now);
        return `${y}W${String(w).padStart(2, '0')}`;
      }
      case 'MONTHLY':
        return `${y}${m}`;
      case 'SEASONAL':
        return `season_${y}`;
      case 'NONE':
      default:
        return 'alltime';
    }
  }

  private isoWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }
}
