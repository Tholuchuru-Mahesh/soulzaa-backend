import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';

@Injectable()
export class AchievementEventService {
  private readonly logger = new Logger(AchievementEventService.name);

  constructor(@Inject(EVENT_BUS) private readonly eventBus: IEventBus) {}

  private async publish(name: string, payload: Record<string, any>) {
    try {
      await this.eventBus.publish({ name, payload, timestamp: new Date() } as any);
    } catch (err) {
      this.logger.error(`Failed to publish event ${name}: ${(err as Error).message}`);
    }
  }

  async publishAchievementUnlocked(
    userId: string,
    achievementId: string,
    achievementCode: string,
    category: string,
  ) {
    await this.publish('achievement.unlocked', { userId, achievementId, achievementCode, category });
  }

  async publishAchievementProgress(
    userId: string,
    achievementId: string,
    currentProgress: number,
    requiredProgress: number,
    percentComplete: number,
  ) {
    await this.publish('achievement.progress', {
      userId,
      achievementId,
      currentProgress,
      requiredProgress,
      percentComplete,
    });
  }

  async publishBadgeUnlocked(userId: string, badgeCode: string) {
    await this.publish('badge.unlocked', { userId, badgeCode });
  }

  async publishBadgeEquipped(userId: string, badgeCode: string) {
    await this.publish('badge.equipped', { userId, badgeCode });
  }

  async publishBadgeUnequipped(userId: string, badgeCode: string) {
    await this.publish('badge.unequipped', { userId, badgeCode });
  }

  async publishRewardClaimed(
    userId: string,
    userAchievementId: string,
    rewardDefinition: Record<string, any>,
  ) {
    await this.publish('achievement.reward_claimed', {
      userId,
      userAchievementId,
      rewardDefinition,
    });
  }
}
