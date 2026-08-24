import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { RewardFulfillmentEngine } from '../services/reward-engine/reward-fulfillment.engine';

export interface RewardDispatchedPayload {
  userId: string;
  taskId?: string;
  missionId?: string;
  rewardDefinition: Record<string, any>;
}

/**
 * Listens for `reward.dispatched` domain events and delegates concrete
 * multi-asset execution to the generic `RewardFulfillmentEngine`.
 */
@Injectable()
export class TaskRewardExecutionListener implements OnModuleInit {
  private readonly logger = new Logger(TaskRewardExecutionListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly rewardEngine: RewardFulfillmentEngine,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe('reward.dispatched', async (event) => {
      await this.handleRewardDispatched(event.payload as RewardDispatchedPayload);
    });
  }

  private async handleRewardDispatched(payload: RewardDispatchedPayload): Promise<void> {
    if (!payload?.userId || !payload?.rewardDefinition) return;

    try {
      await this.rewardEngine.fulfillRewards({
        userId: payload.userId,
        rewardDefinition: payload.rewardDefinition,
        referenceType: payload.taskId ? 'task' : payload.missionId ? 'mission' : 'event',
        referenceId: payload.taskId ?? payload.missionId ?? 'general',
      });
    } catch (err) {
      this.logger.error(
        `Failed to fulfill task reward for user ${payload.userId}: ${(err as Error).message}`,
      );
    }
  }
}

