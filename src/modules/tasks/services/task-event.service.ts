import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';

@Injectable()
export class TaskEventService {
  private readonly logger = new Logger(TaskEventService.name);

  constructor(@Inject(EVENT_BUS) private readonly eventBus: IEventBus) {}

  private async publish(name: string, payload: Record<string, any>) {
    try {
      await this.eventBus.publish({ name, payload, timestamp: new Date() } as any);
    } catch (err) {
      this.logger.error(`Failed to publish event ${name}: ${(err as Error).message}`);
    }
  }

  async publishTaskStarted(taskId: string, userId: string, category: string) {
    await this.publish('task.started', { taskId, userId, category });
  }

  async publishTaskProgressUpdated(
    taskId: string,
    userId: string,
    currentProgress: number,
    requiredProgress: number,
    percentComplete: number,
  ) {
    await this.publish('task.progress.updated', {
      taskId,
      userId,
      currentProgress,
      requiredProgress,
      percentComplete,
    });
  }

  async publishTaskCompleted(taskId: string, userId: string, completionCount: number) {
    await this.publish('task.completed', { taskId, userId, completionCount });
  }

  async publishMissionCompleted(missionId: string, userId: string) {
    await this.publish('mission.completed', { missionId, userId });
  }

  async publishRewardDispatched(
    userId: string,
    taskId?: string,
    missionId?: string,
    rewardDefinition?: Record<string, any>,
  ) {
    await this.publish('reward.dispatched', {
      userId,
      taskId,
      missionId,
      rewardDefinition: rewardDefinition ?? {},
    });
  }

  async publishTaskExpired(taskId: string, reason?: string) {
    await this.publish('task.expired', { taskId, reason });
  }
}
