import { Injectable } from '@nestjs/common';
import {
  WealthClaimStatus,
  WealthExpDirection,
  WealthExpSourceType,
  WealthResetRunStatus,
  type WealthBenefitType,
  type WealthRewardFrequency,
  type WealthRewardGrantType,
  type WealthRewardType,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class WealthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Levels ----

  async listLevels() {
    return this.prisma.wealthLevel.findMany({
      where: { isActive: true },
      orderBy: { level: 'asc' },
    });
  }

  async getLevel(level: number) {
    return this.prisma.wealthLevel.findUnique({ where: { level } });
  }

  async upsertLevel(
    level: number,
    data: {
      name: string;
      expThreshold: bigint;
      displayOrder?: number;
      isActive?: boolean;
      iconUrl?: string | null;
    },
  ) {
    return this.prisma.wealthLevel.upsert({
      where: { level },
      update: data,
      create: { level, ...data },
    });
  }

  async seedLevel(
    level: number,
    data: { name: string; expThreshold: bigint; displayOrder: number },
  ): Promise<boolean> {
    const exists = await this.prisma.wealthLevel.count({ where: { level } });
    if (exists > 0) return false;
    await this.prisma.wealthLevel.create({ data: { level, ...data } });
    return true;
  }

  // ---- Benefits ----

  async listBenefits() {
    return this.prisma.wealthLevelBenefit.findMany({
      where: { isActive: true },
      orderBy: { level: 'asc' },
    });
  }

  async listBenefitsForLevel(level: number) {
    return this.prisma.wealthLevelBenefit.findMany({ where: { level } });
  }

  async createBenefit(data: {
    level: number;
    benefitType: WealthBenefitType;
    config: unknown;
    isActive?: boolean;
    iconUrl?: string | null;
  }) {
    return this.prisma.wealthLevelBenefit.create({
      data: { ...data, config: data.config as Prisma.InputJsonValue },
    });
  }

  async updateBenefit(
    id: string,
    data: Partial<{
      benefitType: WealthBenefitType;
      config: unknown;
      isActive: boolean;
      iconUrl: string | null;
    }>,
  ) {
    return this.prisma.wealthLevelBenefit.update({
      where: { id },
      data: { ...data, config: data.config as Prisma.InputJsonValue | undefined },
    });
  }

  async getBenefit(id: string) {
    return this.prisma.wealthLevelBenefit.findUnique({ where: { id } });
  }

  // ---- Rewards ----

  async listRewardsActive() {
    return this.prisma.wealthLevelReward.findMany({
      where: { isActive: true },
      orderBy: { level: 'asc' },
    });
  }

  async listRewardsForLevel(level: number) {
    return this.prisma.wealthLevelReward.findMany({ where: { level } });
  }

  async getReward(id: string) {
    return this.prisma.wealthLevelReward.findUnique({ where: { id } });
  }

  async createReward(data: {
    level: number;
    rewardType: WealthRewardType;
    rewardValue: unknown;
    frequency: WealthRewardFrequency;
    grantType: WealthRewardGrantType;
    isActive?: boolean;
    startAt?: Date | null;
    endAt?: Date | null;
  }) {
    return this.prisma.wealthLevelReward.create({
      data: { ...data, rewardValue: data.rewardValue as Prisma.InputJsonValue },
    });
  }

  async updateReward(
    id: string,
    data: Partial<{
      rewardType: WealthRewardType;
      rewardValue: unknown;
      frequency: WealthRewardFrequency;
      grantType: WealthRewardGrantType;
      isActive: boolean;
      startAt: Date | null;
      endAt: Date | null;
    }>,
  ) {
    return this.prisma.wealthLevelReward.update({
      where: { id },
      data: { ...data, rewardValue: data.rewardValue as Prisma.InputJsonValue | undefined },
    });
  }

  // ---- Reward claims (idempotent grant/claim) ----

  async findRewardClaim(userId: string, rewardId: string, periodKey: string) {
    return this.prisma.wealthRewardClaim.findUnique({
      where: { userId_rewardId_periodKey: { userId, rewardId, periodKey } },
    });
  }

  /** Idempotent grant: returns the existing row if already granted for this period. */
  async grantRewardClaim(userId: string, rewardId: string, periodKey: string) {
    return this.prisma.wealthRewardClaim.upsert({
      where: { userId_rewardId_periodKey: { userId, rewardId, periodKey } },
      update: {},
      create: { userId, rewardId, periodKey, status: WealthClaimStatus.GRANTED },
    });
  }

  async markClaimed(id: string) {
    return this.prisma.wealthRewardClaim.update({
      where: { id },
      data: { status: WealthClaimStatus.CLAIMED, claimedAt: new Date() },
    });
  }

  async listClaims(userId: string, skip: number, take: number) {
    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.wealthRewardClaim.findMany({
        where,
        skip,
        take,
        orderBy: { grantedAt: 'desc' },
        include: { reward: true },
      }),
      this.prisma.wealthRewardClaim.count({ where }),
    ]);
    return [rows, total] as const;
  }

  // ---- User progress ----

  async getProgress(userId: string) {
    return this.prisma.wealthUserProgress.findUnique({ where: { userId } });
  }

  async listAllProgressUserIds(): Promise<string[]> {
    const rows = await this.prisma.wealthUserProgress.findMany({ select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  // ---- EXP ledger (award / reversal) ----

  async findLedgerByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.wealthExpLedger.findUnique({ where: { idempotencyKey } });
  }

  /** Net EXP still outstanding (AWARD - REVERSAL) for a given purchase, so a reversal never over-reverses. */
  async netAwardedForSourceRef(sourceRef: string): Promise<bigint> {
    const rows = await this.prisma.wealthExpLedger.groupBy({
      by: ['direction'],
      where: { sourceRef },
      _sum: { amount: true },
    });
    let net = 0n;
    for (const r of rows) {
      const sum = r._sum.amount ?? 0n;
      net += r.direction === WealthExpDirection.AWARD ? sum : -sum;
    }
    return net;
  }

  /**
   * Apply an EXP award atomically: upsert progress (increment exp, set the
   * caller-computed effective level) + append the AWARD ledger row + sync the
   * denormalised `UserStatistics.wealthLevel` read cache.
   */
  async applyAward(input: {
    userId: string;
    amount: bigint;
    sourceType: WealthExpSourceType;
    sourceRef: string;
    idempotencyKey: string;
    periodKey: string;
    newLevel: number;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const progress = await tx.wealthUserProgress.upsert({
        where: { userId: input.userId },
        create: {
          userId: input.userId,
          currentExp: input.amount,
          currentLevel: input.newLevel,
          periodKey: input.periodKey,
        },
        update: {
          currentExp: { increment: input.amount },
          currentLevel: input.newLevel,
          periodKey: input.periodKey,
        },
      });

      await tx.wealthExpLedger.create({
        data: {
          userId: input.userId,
          direction: WealthExpDirection.AWARD,
          amount: input.amount,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef,
          idempotencyKey: input.idempotencyKey,
          periodKey: input.periodKey,
          metadata: input.metadata,
        },
      });

      await tx.userStatistics.upsert({
        where: { userId: input.userId },
        update: { wealthLevel: input.newLevel },
        create: { userId: input.userId, wealthLevel: input.newLevel },
      });

      return progress;
    });
  }

  /**
   * Apply an EXP reversal atomically: decrement progress exp (never below 0),
   * set the caller-computed effective level + append the REVERSAL ledger row
   * + sync the `UserStatistics.wealthLevel` cache. No-ops the exp/level
   * change if the reversal arrives after the awarding month has already
   * closed (history is immutable — see WealthMonthlyHistory) but the ledger
   * row is still written for audit.
   */
  async applyReversal(input: {
    userId: string;
    amount: bigint;
    sourceRef: string;
    idempotencyKey: string;
    periodKey: string;
    newExp: bigint | null;
    newLevel: number | null;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.prisma.$transaction(async (tx) => {
      if (input.newExp !== null && input.newLevel !== null) {
        await tx.wealthUserProgress.update({
          where: { userId: input.userId },
          data: { currentExp: input.newExp, currentLevel: input.newLevel },
        });
        await tx.userStatistics.upsert({
          where: { userId: input.userId },
          update: { wealthLevel: input.newLevel },
          create: { userId: input.userId, wealthLevel: input.newLevel },
        });
      }

      await tx.wealthExpLedger.create({
        data: {
          userId: input.userId,
          direction: WealthExpDirection.REVERSAL,
          amount: input.amount,
          sourceType: WealthExpSourceType.PURCHASE_REVERSAL,
          sourceRef: input.sourceRef,
          idempotencyKey: input.idempotencyKey,
          periodKey: input.periodKey,
          metadata: input.metadata,
        },
      });
    });
  }

  // ---- Monthly history / reset idempotency ----

  async getMonthlyHistory(userId: string, periodKey: string) {
    return this.prisma.wealthMonthlyHistory.findUnique({
      where: { userId_periodKey: { userId, periodKey } },
    });
  }

  async createMonthlyHistory(input: {
    userId: string;
    periodKey: string;
    startingLevel: number;
    finalExp: bigint;
    finalLevel: number;
    downgradedToLevel: number | null;
  }) {
    return this.prisma.wealthMonthlyHistory.upsert({
      where: { userId_periodKey: { userId: input.userId, periodKey: input.periodKey } },
      update: {},
      create: input,
    });
  }

  async resetProgressForNewMonth(input: {
    userId: string;
    newPeriodKey: string;
    floorLevel: number;
  }) {
    return this.prisma.wealthUserProgress.update({
      where: { userId: input.userId },
      data: { currentExp: 0n, currentLevel: input.floorLevel, periodKey: input.newPeriodKey },
    });
  }

  async getResetRun(periodKey: string) {
    return this.prisma.wealthMonthlyResetRun.findUnique({ where: { periodKey } });
  }

  /** Returns null if a run for this period already exists (idempotency short-circuit). */
  async tryStartResetRun(periodKey: string) {
    try {
      return await this.prisma.wealthMonthlyResetRun.create({
        data: { periodKey, status: WealthResetRunStatus.RUNNING },
      });
    } catch {
      return null;
    }
  }

  async completeResetRun(periodKey: string, usersProcessed: number) {
    return this.prisma.wealthMonthlyResetRun.update({
      where: { periodKey },
      data: { status: WealthResetRunStatus.COMPLETED, completedAt: new Date(), usersProcessed },
    });
  }

  async failResetRun(periodKey: string) {
    return this.prisma.wealthMonthlyResetRun.update({
      where: { periodKey },
      data: { status: WealthResetRunStatus.FAILED, completedAt: new Date() },
    });
  }

  /** Flips a previously FAILED run back to RUNNING so it can be retried; no-op otherwise. */
  async restartFailedRun(periodKey: string) {
    return this.prisma.wealthMonthlyResetRun.updateMany({
      where: { periodKey, status: WealthResetRunStatus.FAILED },
      data: { status: WealthResetRunStatus.RUNNING, completedAt: null, usersProcessed: 0 },
    });
  }

  // ---- Downgrade configuration ----

  async getActiveDowngradeConfig(now: Date) {
    return this.prisma.wealthDowngradeConfig.findFirst({
      where: {
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  async listDowngradeConfigs() {
    return this.prisma.wealthDowngradeConfig.findMany({ orderBy: { effectiveFrom: 'desc' } });
  }

  async createDowngradeConfig(data: {
    enabled: boolean;
    maxDowngradeLevels: number;
    minLevel: number;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    updatedBy: string;
  }) {
    return this.prisma.wealthDowngradeConfig.create({ data });
  }

  // ---- Generic configuration ----

  async getConfiguration(key: string) {
    return this.prisma.wealthConfiguration.findUnique({ where: { key } });
  }

  async listConfiguration() {
    return this.prisma.wealthConfiguration.findMany({ orderBy: { key: 'asc' } });
  }

  async upsertConfiguration(key: string, value: unknown, updatedBy: string) {
    return this.prisma.wealthConfiguration.upsert({
      where: { key },
      update: { value: value as Prisma.InputJsonValue, updatedBy },
      create: { key, value: value as Prisma.InputJsonValue, updatedBy },
    });
  }

  // ---- Audit ----

  async writeAudit(input: {
    actorId: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
  }) {
    await this.prisma.wealthAudit.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        oldValue: (input.oldValue ?? null) as Prisma.InputJsonValue,
        newValue: (input.newValue ?? null) as Prisma.InputJsonValue,
      },
    });
  }

  async listAudit(skip: number, take: number) {
    const [rows, total] = await Promise.all([
      this.prisma.wealthAudit.findMany({ skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.wealthAudit.count(),
    ]);
    return [rows, total] as const;
  }
}
