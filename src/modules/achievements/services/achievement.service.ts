import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AchievementAuditService } from './achievement-audit.service';
import { AchievementEventService } from './achievement-event.service';
import { AchievementRewardService } from './achievement-reward.service';
import { AchievementStatisticsService } from './achievement-statistics.service';
import { AchievementValidationService } from './achievement-validation.service';

export interface CreateAchievementInput {
  code: string;
  name: string;
  description?: string;
  category: string;
  badgeCode?: string;
  icon?: string;
  displayOrder?: number;
  visibility?: string;
  requiredProgress: number;
  unlockRule?: Record<string, any>;
  rewardDefinition?: Record<string, any>;
  repeatable?: boolean;
  hidden?: boolean;
  expiresAt?: Date;
  actorId?: string;
}

@Injectable()
export class AchievementService {
  private readonly logger = new Logger(AchievementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: AchievementValidationService,
    private readonly rewardService: AchievementRewardService,
    private readonly statisticsService: AchievementStatisticsService,
    private readonly auditService: AchievementAuditService,
    private readonly eventService: AchievementEventService,
  ) {}

  async createAchievement(input: CreateAchievementInput) {
    const def = await this.prisma.achievementDefinition.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description,
        category: input.category,
        badgeCode: input.badgeCode,
        icon: input.icon,
        displayOrder: input.displayOrder ?? 0,
        visibility: input.visibility ?? 'PUBLIC',
        requiredProgress: input.requiredProgress,
        unlockRule: input.unlockRule ?? {},
        rewardDefinition: input.rewardDefinition ?? {},
        repeatable: input.repeatable ?? false,
        hidden: input.hidden ?? false,
        expiresAt: input.expiresAt,
      },
    });

    await this.auditService.logAudit('ACHIEVEMENT_CREATED', undefined, input.actorId, {
      achievementId: def.id,
      code: def.code,
    });

    return def;
  }

  /**
   * Core unlock operation — awards achievement to user after all validations.
   */
  async unlockAchievement(
    userId: string,
    achievementId: string,
    actorId?: string,
    autoClaim = true,
  ) {
    const def = await this.validationService.validateAchievementExists(achievementId);
    await this.validationService.validateNotAlreadyUnlocked(userId, achievementId, def.repeatable);

    // Determine iteration for repeatable achievements
    const iterationCount = def.repeatable
      ? await this.prisma.userAchievement.count({ where: { userId, achievementId } })
      : 0;

    const unlock = await this.prisma.userAchievement.create({
      data: {
        userId,
        achievementId,
        grantedBy: actorId,
        unlockIteration: iterationCount + 1,
      },
    });

    // Reset progress
    await this.prisma.achievementProgress.updateMany({
      where: { userId, achievementId },
      data: { isCompleted: true, completedAt: new Date() },
    });

    await this.statisticsService.incrementUnlocks();
    await this.auditService.logAudit('ACHIEVEMENT_UNLOCKED', userId, actorId, {
      achievementId,
      achievementCode: def.code,
      iteration: unlock.unlockIteration,
    });
    await this.eventService.publishAchievementUnlocked(userId, def.id, def.code, def.category);

    // Award badge if defined on achievement
    if (def.badgeCode) {
      await this.awardBadge(userId, def.badgeCode, achievementId, actorId);
    }

    // Auto-claim reward if enabled
    if (autoClaim && def.rewardDefinition && Object.keys(def.rewardDefinition as object).length > 0) {
      await this.rewardService.claimReward(userId, unlock.id, def.rewardDefinition as Record<string, any>, actorId);
    }

    return unlock;
  }

  private async awardBadge(userId: string, badgeCode: string, sourceRefId: string, actorId?: string) {
    const badge = await this.prisma.badgeDefinition.findUnique({ where: { code: badgeCode } });
    if (!badge || badge.status !== 'ACTIVE') return;

    await this.prisma.badgeInventory.upsert({
      where: { userId_badgeCode: { userId, badgeCode } },
      update: {},
      create: { userId, badgeCode, source: 'ACHIEVEMENT', sourceRefId },
    });

    await this.statisticsService.incrementBadgesAwarded();
    await this.auditService.logAudit('BADGE_UNLOCKED', userId, actorId, { badgeCode, sourceRefId });
    await this.eventService.publishBadgeUnlocked(userId, badgeCode);
  }

  async getUserAchievements(userId: string) {
    return this.prisma.userAchievement.findMany({
      where: { userId },
      include: { achievement: true },
      orderBy: { unlockedAt: 'desc' },
    });
  }

  async getAchievementDefinitions(category?: string, status = 'ACTIVE') {
    const where: any = { status };
    if (category) where.category = category;
    return this.prisma.achievementDefinition.findMany({
      where,
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async getAchievementDefinition(idOrCode: string) {
    const byId = await this.prisma.achievementDefinition.findUnique({ where: { id: idOrCode } });
    if (byId) return byId;
    return this.prisma.achievementDefinition.findUnique({ where: { code: idOrCode } });
  }

  async updateAchievementStatus(id: string, status: string, actorId?: string) {
    const updated = await this.prisma.achievementDefinition.update({
      where: { id },
      data: { status },
    });
    await this.auditService.logAudit('ACHIEVEMENT_CREATED', undefined, actorId, { id, status });
    return updated;
  }

  async manualGrant(userId: string, achievementId: string, actorId: string) {
    await this.validationService.validateUserExists(userId);
    const unlock = await this.unlockAchievement(userId, achievementId, actorId, true);
    await this.auditService.logAudit('ACHIEVEMENT_MANUAL_GRANT', userId, actorId, { achievementId });
    return unlock;
  }
}
