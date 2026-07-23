import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';

@Injectable()
export class LevelEventService {
  private readonly logger = new Logger(LevelEventService.name);

  constructor(@Inject(EVENT_BUS) private readonly eventBus: IEventBus) {}

  async publishLevelEvent(eventName: string, payload: Record<string, any>) {
    try {
      await this.eventBus.publish({
        name: eventName,
        payload,
        timestamp: new Date(),
      } as any);
    } catch (err) {
      this.logger.error(`Failed to publish domain event ${eventName}: ${(err as Error).message}`);
    }
  }

  async publishLevelUp(userId: string, previousLevel: number, newLevel: number, totalExp: bigint) {
    await this.publishLevelEvent('level.up', {
      userId,
      previousLevel,
      newLevel,
      totalExp: totalExp.toString(),
    });
  }

  async publishExpAdded(userId: string, amount: number, sourceCode: string, newTotalExp: bigint) {
    await this.publishLevelEvent('exp.added', {
      userId,
      amount,
      sourceCode,
      newTotalExp: newTotalExp.toString(),
    });
  }

  async publishExpRemoved(userId: string, amount: number, newTotalExp: bigint) {
    await this.publishLevelEvent('exp.removed', {
      userId,
      amount,
      newTotalExp: newTotalExp.toString(),
    });
  }

  async publishProgressUpdated(userId: string, currentLevel: number, progressPercentage: number) {
    await this.publishLevelEvent('progress.updated', {
      userId,
      currentLevel,
      progressPercentage,
    });
  }
}
