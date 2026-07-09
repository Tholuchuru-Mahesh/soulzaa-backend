import { Injectable } from '@nestjs/common';
import { Prisma, VipConfig, VipLevel, VipStatus } from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Data layer for VIP: the per-user status aggregate, the admin tier configs, the
 * idempotent recharge ledger and the immutable upgrade log. The recharge
 * accrual read-modify-write is done transactionally; the service serialises
 * callers per-user with a lock.
 */
@Injectable()
export class VipRepository {
  constructor(private readonly prisma: PrismaService) {}

  getStatus(userId: string): Promise<VipStatus | null> {
    return this.prisma.vipStatus.findUnique({ where: { userId } });
  }

  findRechargeLog(idempotencyKey: string): Promise<{ id: string } | null> {
    return this.prisma.vipRechargeLog.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
  }

  /** Apply a recharge delta + ledger row atomically; returns the new status. */
  applyRecharge(input: {
    userId: string;
    amount: bigint;
    idempotencyKey: string;
    newLevel: VipLevel;
  }): Promise<VipStatus> {
    return this.prisma.$transaction(async (tx) => {
      const status = await tx.vipStatus.upsert({
        where: { userId: input.userId },
        create: { userId: input.userId },
        update: {},
      });
      const totalAfter = status.lifetimeRecharge + input.amount;
      const updated = await tx.vipStatus.update({
        where: { userId: input.userId },
        data: { lifetimeRecharge: totalAfter, level: input.newLevel },
      });
      await tx.vipRechargeLog.create({
        data: {
          userId: input.userId,
          amount: input.amount,
          idempotencyKey: input.idempotencyKey,
          totalAfter,
        },
      });
      return updated;
    });
  }

  async logUpgrade(input: {
    userId: string;
    fromLevel: VipLevel;
    toLevel: VipLevel;
    lifetimeRecharge: bigint;
  }): Promise<void> {
    await this.prisma.vipLog.create({ data: input });
  }

  // ---- Config ----

  listConfigs(): Promise<VipConfig[]> {
    return this.prisma.vipConfig.findMany({ orderBy: { minRecharge: 'asc' } });
  }

  upsertConfig(
    level: VipLevel,
    data: { minRecharge: bigint; benefits: Prisma.InputJsonValue },
    actorId: string,
  ): Promise<VipConfig> {
    return this.prisma.vipConfig.upsert({
      where: { level },
      create: { level, ...data, ...auditCreate(actorId) },
      update: { ...data, ...auditUpdate(actorId) },
    });
  }

  async seedConfig(
    level: VipLevel,
    minRecharge: bigint,
    benefits: Prisma.InputJsonValue,
  ): Promise<boolean> {
    const exists = await this.prisma.vipConfig.count({ where: { level } });
    if (exists > 0) return false;
    await this.prisma.vipConfig.create({ data: { level, minRecharge, benefits } });
    return true;
  }
}
