import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskEvaluationService } from './task-evaluation.service';

@Injectable()
export class TaskQueryService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(forwardRef(() => TaskEvaluationService))
    private readonly evaluation?: TaskEvaluationService,
  ) {}

  /**
   * Returns user active tasks with progress overlay for current period.
   * Universal evaluation runs on access to ensure session active state is reflected.
   */
  async getUserActiveTasks(userId: string, category?: string) {
    const tasks = await this.prisma.taskDefinition.findMany({
      where: {
        ...(category ? { category } : {}),
        status: 'ACTIVE',
      },
      include: { mission: true },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });

    const taskIds = tasks.map((t) => t.id);
    const progresses = await this.prisma.taskProgress.findMany({
      where: { userId, taskId: { in: taskIds } },
    });

    const progressMap = new Map(progresses.map((p) => [`${p.taskId}:${p.periodKey}`, p]));

    // Check reward claims for these tasks
    const rewards = await this.prisma.taskReward.findMany({
      where: { userId, taskId: { in: taskIds }, claimed: true },
      orderBy: { claimedAt: 'desc' },
    });

    const now = new Date();
    const todayStartUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    return tasks.map((task) => {
      const periodKey = this.buildPeriodKey(task.resetPolicy);
      const progress = progressMap.get(`${task.id}:${periodKey}`);

      // Check if reward was already claimed in this period
      const lastReward = rewards.find((r) => r.taskId === task.id);
      let isClaimed = false;
      if (lastReward?.claimedAt) {
        if (task.resetPolicy === 'DAILY') {
          isClaimed = lastReward.claimedAt >= todayStartUtc;
        } else {
          isClaimed = true;
        }
      }

      return {
        task,
        progress: progress
          ? {
              currentProgress: progress.currentProgress,
              requiredProgress: progress.requiredProgress,
              percentComplete: progress.percentComplete,
              isCompleted: progress.isCompleted,
              isClaimed,
              completionCount: progress.completionCount,
              completedAt: progress.completedAt,
              periodKey: progress.periodKey,
            }
          : {
              currentProgress: 0,
              requiredProgress: task.requiredProgress,
              percentComplete: 0,
              isCompleted: false,
              isClaimed: false,
              completionCount: 0,
              completedAt: null,
              periodKey,
            },
      };
    });
  }

  private buildPeriodKey(resetPolicy: string): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');

    switch (resetPolicy) {
      case 'DAILY':
        return `${y}${m}${d}`;
      case 'WEEKLY': {
        const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        const dayNum = date.getUTCDay() || 7;
        date.setUTCDate(date.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        const w = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
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

  /**
   * Mobile-facing: returns ALL active tasks (event missions + daily tasks)
   * as a flat array with user progress overlaid. Used by GET /tasks/mobile/feed.
   */
  async getMobileFeed(userId?: string): Promise<any[]> {
    const now = new Date();

    const tasks = await this.prisma.taskDefinition.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ endTime: null }, { endTime: { gte: now } }],
      },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });

    if (tasks.length === 0) return [];

    let progressMap = new Map<string, any>();
    const claimedSet = new Set<string>();
    if (userId) {
      const progresses = await this.prisma.taskProgress.findMany({
        where: { userId, taskId: { in: tasks.map((t) => t.id) } },
      });
      progressMap = new Map(progresses.map((p) => [p.taskId, p]));

      const rewards = await this.prisma.taskReward.findMany({
        where: { userId, taskId: { in: tasks.map((t) => t.id) }, claimed: true },
      });
      rewards.forEach((r) => {
        if (r.taskId) claimedSet.add(r.taskId);
      });
    }

    const eventTaskCodes = [
      ...new Set(
        tasks
          .filter((t) => t.category === 'EVENT_MISSION')
          .map((t) => t.code.split('_TASK_')[0])
          .filter(Boolean),
      ),
    ];

    const eventNameMap = new Map<string, string>();
    if (eventTaskCodes.length > 0) {
      const events = await this.prisma.eventDefinition.findMany({
        where: { code: { in: eventTaskCodes }, status: { in: ['ACTIVE', 'APPROVED'] } },
        select: { code: true, name: true },
      });
      events.forEach((e) => eventNameMap.set(e.code, e.name));
    }

    return tasks.map((task) => {
      const progress = progressMap.get(task.id);
      const isClaimed = claimedSet.has(task.id);
      const currentProgress = progress?.currentProgress ?? 0;
      const requiredProgress = progress?.requiredProgress ?? task.requiredProgress;
      const isCompleted = progress?.isCompleted ?? false;

      let eventName: string | null = null;
      if (task.category === 'EVENT_MISSION') {
        const eventCode = task.code.split('_TASK_')[0];
        eventName = eventNameMap.get(eventCode) ?? null;
      }

      return {
        id: task.id,
        code: task.code,
        name: task.name,
        description: task.description,
        category: task.category,
        objective: task.objective,
        requiredProgress,
        currentProgress,
        percentComplete:
          requiredProgress > 0 ? Math.round((currentProgress / requiredProgress) * 100) : 0,
        isCompleted,
        isClaimed,
        difficulty: task.difficulty,
        priority: task.priority,
        rewardDefinition: task.rewardDefinition,
        startTime: task.startTime,
        endTime: task.endTime,
        eventName,
        status: task.status,
      };
    });
  }

  /**
   * Self-scoped reward claim for regular users.
   * Records a TaskReward entry so getMobileFeed() marks isClaimed=true.
   */
  async selfClaimReward(
    userId: string,
    taskId: string,
  ): Promise<{ success: boolean; message: string }> {
    const task = await this.prisma.taskDefinition.findUnique({ where: { id: taskId } });
    if (!task || task.status !== 'ACTIVE') {
      return { success: false, message: 'Task not found or not active.' };
    }

    const progress = await this.prisma.taskProgress.findFirst({ where: { userId, taskId } });
    const currentProgress = progress?.currentProgress ?? 0;
    if (currentProgress < task.requiredProgress) {
      return { success: false, message: 'Task not yet completed.' };
    }

    const existing = await this.prisma.taskReward.findFirst({
      where: { userId, taskId, claimed: true },
    });
    if (existing) {
      return { success: false, message: 'Reward already claimed.' };
    }

    await this.prisma.taskReward.create({
      data: {
        userId,
        taskId,
        missionId: null,
        rewardDefinition: (task.rewardDefinition as any) ?? {},
        claimed: true,
        claimedAt: new Date(),
      },
    });

    return { success: true, message: 'Reward claimed successfully.' };
  }

  /**
   * Retrieves task execution history for a user.
   */
  async getUserTaskHistory(userId: string, limit = 50, offset = 0) {
    const [items, total] = await Promise.all([
      this.prisma.taskHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.taskHistory.count({ where: { userId } }),
    ]);

    return { items, total, limit, offset };
  }

  /**
   * Retrieves tasks grouped by category.
   */
  async getTasksByCategory(category: string) {
    return this.prisma.taskDefinition.findMany({
      where: { category, status: 'ACTIVE' },
      include: { mission: true },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * Task 25 — Moderator assignment summary.
   */
  async moderatorAssignmentSummary(moderatorId: string): Promise<{
    assigned: number;
    completed: number;
    pending: number;
    overdue: number;
    overduePercentage: number;
  }> {
    const now = new Date();

    const [assigned, completed, overdue] = await Promise.all([
      this.prisma.moderator_task_assignments.count({ where: { moderatorId } }),
      this.prisma.moderator_task_assignments.count({ where: { moderatorId, status: 'COMPLETED' } }),
      this.prisma.moderator_task_assignments.count({
        where: {
          moderatorId,
          dueAt: { lt: now },
          status: { not: 'COMPLETED' },
        },
      }),
    ]);

    const pending = assigned - completed;
    const overduePercentage = assigned > 0 ? Math.round((overdue / assigned) * 100) : 0;

    return { assigned, completed, pending, overdue, overduePercentage };
  }
}
