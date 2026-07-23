import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { LevelAuditService } from './level-audit.service';
import { LevelCalculationService } from './level-calculation.service';
import { LevelConfigurationService } from './level-configuration.service';
import { LevelEventService } from './level-event.service';

export interface UpsertLevelDefinitionInput {
  level: number;
  title?: string;
  requiredExp: bigint;
  icon?: string;
  badgeUrl?: string;
}

@Injectable()
export class LevelService {
  private readonly logger = new Logger(LevelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly calculationService: LevelCalculationService,
    private readonly configService: LevelConfigurationService,
    private readonly auditService: LevelAuditService,
    private readonly eventService: LevelEventService,
  ) {}

  async getUserLevel(userId: string) {
    let userLevel = await this.prisma.userLevel.findUnique({
      where: { userId },
    });

    if (!userLevel) {
      userLevel = await this.prisma.userLevel.create({
        data: {
          userId,
          currentLevel: 1,
          lifetimeExp: BigInt(0),
        },
      });
    }

    const params = await this.configService.getParameters();
    const progress = await this.calculationService.calculateUserLevel(
      userLevel.lifetimeExp,
      params.maxLevel,
    );

    return {
      userId: userLevel.userId,
      currentLevel: userLevel.currentLevel,
      lifetimeExp: userLevel.lifetimeExp.toString(),
      dailyExp: userLevel.dailyExp.toString(),
      weeklyExp: userLevel.weeklyExp.toString(),
      monthlyExp: userLevel.monthlyExp.toString(),
      progressPercentage: progress.progressPercentage,
      expForCurrentLevel: progress.expForCurrentLevel.toString(),
      expForNextLevel: progress.expForNextLevel.toString(),
      isMaxLevel: progress.isMaxLevel,
    };
  }

  async recalculateUserLevel(userId: string, actorId?: string) {
    const lockKey = `exp:user:${userId}`;

    return this.locks.withLock(lockKey, async () => {
      const userLevel = await this.prisma.userLevel.findUnique({
        where: { userId },
      });

      if (!userLevel) return null;

      const params = await this.configService.getParameters();
      const calc = await this.calculationService.calculateUserLevel(
        userLevel.lifetimeExp,
        params.maxLevel,
      );

      const previousLevel = userLevel.currentLevel;
      const updated = await this.prisma.userLevel.update({
        where: { userId },
        data: { currentLevel: calc.currentLevel },
      });

      if (calc.currentLevel !== previousLevel) {
        await this.eventService.publishLevelUp(
          userId,
          previousLevel,
          calc.currentLevel,
          userLevel.lifetimeExp,
        );
      }

      await this.eventService.publishLevelEvent('level.recalculated', {
        userId,
        previousLevel,
        newLevel: calc.currentLevel,
      });

      await this.auditService.logAudit('LEVEL_RECALCULATED', userId, actorId, {
        previousLevel,
        newLevel: calc.currentLevel,
      });

      return {
        ...updated,
        lifetimeExp: updated.lifetimeExp.toString(),
      };
    });
  }

  async upsertLevelDefinition(input: UpsertLevelDefinitionInput, actorId?: string) {
    const def = await this.prisma.levelDefinition.upsert({
      where: { level: input.level },
      update: {
        title: input.title,
        requiredExp: input.requiredExp,
        icon: input.icon,
        badgeUrl: input.badgeUrl,
        status: 'ACTIVE',
      },
      create: {
        level: input.level,
        title: input.title,
        requiredExp: input.requiredExp,
        icon: input.icon,
        badgeUrl: input.badgeUrl,
        status: 'ACTIVE',
      },
    });

    await this.auditService.logAudit('LEVEL_CREATED', undefined, actorId, {
      level: def.level,
      requiredExp: def.requiredExp.toString(),
    });

    return {
      ...def,
      requiredExp: def.requiredExp.toString(),
    };
  }

  async getLevelDefinitions() {
    const defs = await this.prisma.levelDefinition.findMany({
      orderBy: { level: 'asc' },
    });

    return defs.map((d) => ({
      ...d,
      requiredExp: d.requiredExp.toString(),
    }));
  }
}
