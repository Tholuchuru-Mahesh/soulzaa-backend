import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskAuditService } from './task-audit.service';
import { TaskEventService } from './task-event.service';

@Injectable()
export class TaskRewardService {
  private readonly logger = new Logger(TaskRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: TaskAuditService,
    private readonly eventService: TaskEventService,
  ) {}

  /**
   * Dispatches reward for a completed task or mission.
   * Records the reward in `task_rewards` and publishes `reward.dispatched`.
   * Decoupled from Wallet/EXP modules.
   */
  async dispatchReward(
    userId: string,
    taskId?: string,
    missionId?: string,
    customReward?: Record<string, any>,
    actorId?: string,
  ) {
    let rewardDef: Record<string, any> = customReward ?? {};

    if (!customReward) {
      if (taskId) {
        const task = await this.prisma.taskDefinition.findUnique({ where: { id: taskId } });
        rewardDef = (task?.rewardDefinition as Record<string, any>) ?? {};
      } else if (missionId) {
        const mission = await this.prisma.missionDefinition.findUnique({ where: { id: missionId } });
        rewardDef = (mission?.rewardDefinition as Record<string, any>) ?? {};
      }
    }

    const reward = await this.prisma.taskReward.create({
      data: {
        userId,
        taskId,
        missionId,
        rewardDefinition: rewardDef,
        claimed: true,
        claimedAt: new Date(),
      },
    });

    await this.auditService.logAudit('TASK_REWARD_DISPATCHED', taskId, actorId ?? userId, {
      userId,
      missionId,
      rewardId: reward.id,
      rewardDefinition: rewardDef,
    });

    await this.eventService.publishRewardDispatched(userId, taskId, missionId, rewardDef);

    this.logger.log(`Reward dispatched to user ${userId} for task=${taskId} mission=${missionId}`);

    return reward;
  }

  async getUserRewards(userId: string) {
    return this.prisma.taskReward.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
