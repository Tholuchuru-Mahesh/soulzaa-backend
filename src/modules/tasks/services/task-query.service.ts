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
    // Trigger generic user active/login event evaluation through the rule engine
    if (this.evaluation) {
      try {
        await this.evaluation.evaluateEvent({
          userId,
          eventCode: 'user.logged_in',
          metadata: { trigger: 'query_active' },
        });
      } catch {
        // Non-fatal
      }
    }

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
    const todayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

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
   * Returns combined Assigned/Completed/Pending/Overdue counts and overdue percentage.
   * Overdue = assignments past their dueAt without COMPLETED status.
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
      // Overdue: dueAt in the past AND status not COMPLETED
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
