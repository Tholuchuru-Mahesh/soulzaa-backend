import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class TaskQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns user active tasks with progress overlay for current period.
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

    const progressMap = new Map(progresses.map((p) => [p.taskId, p]));

    return tasks.map((task) => {
      const progress = progressMap.get(task.id);
      return {
        task,
        progress: progress
          ? {
              currentProgress: progress.currentProgress,
              requiredProgress: progress.requiredProgress,
              percentComplete: progress.percentComplete,
              isCompleted: progress.isCompleted,
              completionCount: progress.completionCount,
              completedAt: progress.completedAt,
            }
          : {
              currentProgress: 0,
              requiredProgress: task.requiredProgress,
              percentComplete: 0,
              isCompleted: false,
              completionCount: 0,
              completedAt: null,
            },
      };
    });
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
