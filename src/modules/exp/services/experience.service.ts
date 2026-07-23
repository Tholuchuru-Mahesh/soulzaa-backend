import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { LevelAuditService } from './level-audit.service';
import { LevelCalculationService } from './level-calculation.service';
import { LevelConfigurationService } from './level-configuration.service';
import { LevelEventService } from './level-event.service';
import { LevelStatisticsService } from './level-statistics.service';
import { LevelValidationService } from './level-validation.service';

export interface AddExpInput {
  userId: string;
  amount: number;
  sourceCode: string;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  actorId?: string;
}

export interface RemoveExpInput {
  userId: string;
  amount: number;
  reason: string;
  actorId?: string;
}

@Injectable()
export class ExperienceService {
  private readonly logger = new Logger(ExperienceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly validationService: LevelValidationService,
    private readonly calculationService: LevelCalculationService,
    private readonly configService: LevelConfigurationService,
    private readonly auditService: LevelAuditService,
    private readonly statisticsService: LevelStatisticsService,
    private readonly eventService: LevelEventService,
  ) {}

  /**
   * Awards EXP to user with exact-once idempotency replay protection under user lock.
   */
  async addExp(input: AddExpInput) {
    const { userId, amount, sourceCode, idempotencyKey, referenceType, referenceId, actorId } =
      input;

    // 1. Validations
    await this.validationService.validateUserExists(userId);
    await this.validationService.validateSourceExists(sourceCode);
    this.validationService.validateExpAmount(amount);

    const lockKey = `exp:user:${userId}`;

    return this.locks.withLock(lockKey, async () => {
      // 2. Re-check idempotency inside lock for complete race condition safety
      const existingHistory = await this.prisma.experienceHistory.findUnique({
        where: { idempotencyKey },
      });

      if (existingHistory) {
        const userLevel = await this.prisma.userLevel.findUnique({ where: { userId } });
        return {
          duplicate: true,
          historyId: existingHistory.id,
          currentLevel: userLevel?.currentLevel ?? 1,
          totalExp: userLevel?.lifetimeExp.toString() ?? '0',
          levelUps: 0,
        };
      }

      await this.validationService.validateLimits(userId, amount);

      // 3. Load or initialize UserLevel aggregate
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

      const previousLevel = userLevel.currentLevel;
      const previousExp = userLevel.lifetimeExp;
      const newTotalExp = previousExp + BigInt(amount);

      // 4. Calculate new Level & detection of multi-level jumps
      const params = await this.configService.getParameters();
      const calcResult = await this.calculationService.calculateUserLevel(
        newTotalExp,
        params.maxLevel,
      );

      const newLevel = calcResult.currentLevel;
      const levelUps = Math.max(0, newLevel - previousLevel);

      // 5. Update aggregate & record history atomically in transaction
      try {
        const { history } = await this.prisma.$transaction(async (tx) => {
          const h = await tx.experienceHistory.create({
            data: {
              userId,
              amount,
              sourceCode,
              idempotencyKey,
              referenceType,
              referenceId,
              previousLevel,
              newLevel,
              totalExpAfter: newTotalExp,
            },
          });

          await tx.userLevel.update({
            where: { userId },
            data: {
              currentLevel: newLevel,
              lifetimeExp: newTotalExp,
              dailyExp: { increment: BigInt(amount) },
              weeklyExp: { increment: BigInt(amount) },
              monthlyExp: { increment: BigInt(amount) },
            },
          });

          return { history: h };
        });

        // 6. Post-transaction Stats, Audits & Events
        await this.statisticsService.updateStatistics(amount, levelUps);
        await this.auditService.logAudit('EXP_ADDED', userId, actorId, {
          amount,
          sourceCode,
          idempotencyKey,
          previousLevel,
          newLevel,
        });

        await this.eventService.publishExpAdded(userId, amount, sourceCode, newTotalExp);

        if (levelUps > 0) {
          await this.auditService.logAudit('LEVEL_UP', userId, actorId, {
            previousLevel,
            newLevel,
            levelUps,
          });
          await this.eventService.publishLevelUp(userId, previousLevel, newLevel, newTotalExp);
        }

        await this.eventService.publishProgressUpdated(
          userId,
          newLevel,
          calcResult.progressPercentage,
        );

        return {
          duplicate: false,
          historyId: history.id,
          currentLevel: newLevel,
          totalExp: newTotalExp.toString(),
          levelUps,
          progressPercentage: calcResult.progressPercentage,
        };
      } catch (err: any) {
        // Handle P2002 unique constraint error if concurrent key arrived
        if (err?.code === 'P2002' || err?.message?.includes('Unique constraint')) {
          const recheckedHistory = await this.prisma.experienceHistory.findUnique({
            where: { idempotencyKey },
          });
          const currentUserLevel = await this.prisma.userLevel.findUnique({ where: { userId } });
          return {
            duplicate: true,
            historyId: recheckedHistory?.id,
            currentLevel: currentUserLevel?.currentLevel ?? 1,
            totalExp: currentUserLevel?.lifetimeExp.toString() ?? '0',
            levelUps: 0,
          };
        }
        throw err;
      }
    });
  }

  /**
   * Deducts EXP from user under user lock.
   */
  async removeExp(input: RemoveExpInput) {
    const { userId, amount, reason, actorId } = input;

    await this.validationService.validateUserExists(userId);
    this.validationService.validateExpAmount(amount);

    const lockKey = `exp:user:${userId}`;

    return this.locks.withLock(lockKey, async () => {
      const userLevel = await this.prisma.userLevel.findUnique({
        where: { userId },
      });

      if (!userLevel) {
        throw new BadRequestException(`User level aggregate does not exist for user ${userId}`);
      }

      const previousLevel = userLevel.currentLevel;
      const currentExp = userLevel.lifetimeExp;
      const newTotalExp = currentExp > BigInt(amount) ? currentExp - BigInt(amount) : BigInt(0);

      const params = await this.configService.getParameters();
      const calcResult = await this.calculationService.calculateUserLevel(
        newTotalExp,
        params.maxLevel,
      );

      const newLevel = calcResult.currentLevel;

      await this.prisma.userLevel.update({
        where: { userId },
        data: {
          currentLevel: newLevel,
          lifetimeExp: newTotalExp,
        },
      });

      await this.auditService.logAudit('EXP_REMOVED', userId, actorId, {
        amount,
        reason,
        previousLevel,
        newLevel,
      });

      await this.eventService.publishExpRemoved(userId, amount, newTotalExp);
      await this.eventService.publishProgressUpdated(
        userId,
        newLevel,
        calcResult.progressPercentage,
      );

      return {
        currentLevel: newLevel,
        totalExp: newTotalExp.toString(),
        progressPercentage: calcResult.progressPercentage,
      };
    });
  }
}
