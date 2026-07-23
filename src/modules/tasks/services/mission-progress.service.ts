import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskAuditService } from './task-audit.service';
import { TaskEventService } from './task-event.service';

@Injectable()
export class MissionProgressService {
  private readonly logger = new Logger(MissionProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: TaskAuditService,
    private readonly eventService: TaskEventService,
  ) {}

  /**
   * Recalculates and updates mission progress for a user after a task within the mission is completed.
   */
  async evaluateMissionProgress(userId: string, missionId: string) {
    const mission = await this.prisma.missionDefinition.findUnique({
      where: { id: missionId },
      include: { tasks: true },
    });

    if (!mission) return null;

    const taskIds = mission.tasks.map((t) => t.id);
    if (taskIds.length === 0) return null;

    // Count how many distinct tasks in this mission the user has completed
    const completedTasksCount = await this.prisma.taskProgress.count({
      where: {
        userId,
        taskId: { in: taskIds },
        isCompleted: true,
      },
    });

    const isCompleted = completedTasksCount >= mission.requiredTaskCount;

    const record = await this.prisma.missionProgress.upsert({
      where: { missionId_userId: { missionId, userId } },
      update: {
        completedTaskCount: completedTasksCount,
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
        updatedAt: new Date(),
      },
      create: {
        missionId,
        userId,
        completedTaskCount: completedTasksCount,
        requiredTaskCount: mission.requiredTaskCount,
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
      },
    });

    if (isCompleted) {
      await this.auditService.logAudit('MISSION_COMPLETED', undefined, userId, {
        missionId,
        completedTaskCount: completedTasksCount,
      });
      await this.eventService.publishMissionCompleted(missionId, userId);
    }

    return record;
  }

  async getUserMissionProgress(userId: string, missionId?: string) {
    return this.prisma.missionProgress.findMany({
      where: { userId, ...(missionId ? { missionId } : {}) },
      include: { mission: true },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
