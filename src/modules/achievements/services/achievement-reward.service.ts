import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AchievementAuditService } from './achievement-audit.service';
import { AchievementEventService } from './achievement-event.service';
import { AchievementStatisticsService } from './achievement-statistics.service';
import { AchievementValidationService } from './achievement-validation.service';

@Injectable()
export class AchievementRewardService {
  private readonly logger = new Logger(AchievementRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: AchievementValidationService,
    private readonly statisticsService: AchievementStatisticsService,
    private readonly auditService: AchievementAuditService,
    private readonly eventService: AchievementEventService,
  ) {}

  /**
   * Claims the reward attached to an unlocked achievement.
   * Marks the UserAchievement as reward-claimed and publishes event.
   */
  async claimReward(
    userId: string,
    userAchievementId: string,
    rewardDefinition: Record<string, any>,
    actorId?: string,
  ) {
    // Idempotent: if already claimed, return early
    const unlock = await this.prisma.userAchievement.findUnique({
      where: { id: userAchievementId },
    });

    if (!unlock) {
      this.logger.warn(`UserAchievement ${userAchievementId} not found for claim`);
      return null;
    }

    if (unlock.rewardClaimed) {
      this.logger.debug(`Reward already claimed for UserAchievement ${userAchievementId}`);
      return { alreadyClaimed: true };
    }

    await this.prisma.userAchievement.update({
      where: { id: userAchievementId },
      data: { rewardClaimed: true, claimedAt: new Date() },
    });

    await this.statisticsService.incrementRewardsClaimed();

    await this.auditService.logAudit('ACHIEVEMENT_REWARD_CLAIMED', userId, actorId, {
      userAchievementId,
      rewardDefinition,
    });

    await this.eventService.publishRewardClaimed(userId, userAchievementId, rewardDefinition);

    // NOTE: Actual reward dispatch (coins, EXP, items) is handled by the
    // respective module listening to `achievement.reward_claimed` event.
    // The Achievement Engine records the claim only — no wallet coupling.

    return {
      alreadyClaimed: false,
      userId,
      userAchievementId,
      rewardDefinition,
      claimedAt: new Date(),
    };
  }

  async claimRewardByAchievementId(userId: string, achievementId: string, actorId?: string) {
    await this.validationService.validateRewardEligibility(userId, achievementId);

    const def = await this.prisma.achievementDefinition.findUnique({
      where: { id: achievementId },
    });

    if (!def?.rewardDefinition) {
      return { alreadyClaimed: false, noReward: true };
    }

    const unlock = await this.prisma.userAchievement.findFirst({
      where: { userId, achievementId, rewardClaimed: false },
      orderBy: { unlockedAt: 'desc' },
    });

    if (!unlock) {
      return { alreadyClaimed: true };
    }

    return this.claimReward(
      userId,
      unlock.id,
      def.rewardDefinition as Record<string, any>,
      actorId,
    );
  }
}
