import { Injectable } from '@nestjs/common';
import { VipLevel } from 'src/common/enums/vip-level.enum';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class VipRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(userId: string) {
    const m = await this.prisma.vipMembership.findUnique({ where: { userId } });
    if (!m) return null;
    return {
      userId: m.userId,
      level: `VIP_${m.level}` as any,
      lifetimeRecharge: m.totalSpent,
    };
  }

  async findRechargeLog(idempotencyKey: string) {
    const sub = await this.prisma.vipSubscription.findFirst({
      where: { id: idempotencyKey },
      select: { id: true },
    });
    return sub;
  }

  async applyRecharge(input: {
    userId: string;
    amount: bigint;
    idempotencyKey: string;
    newLevel: VipLevel;
  }) {
    const m = await this.prisma.vipMembership.findUnique({ where: { userId: input.userId } });
    if (!m) {
      const tier = await this.prisma.vipTier.findFirst({ orderBy: { level: 'asc' } });
      const created = await this.prisma.vipMembership.create({
        data: {
          userId: input.userId,
          tierId: tier?.id ?? '00000000-0000-0000-0000-000000000000',
          level: 1,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
          totalSpent: input.amount,
        },
      });
      return {
        userId: created.userId,
        level: VipLevel.BRONZE,
        lifetimeRecharge: created.totalSpent,
      };
    }
    const updated = await this.prisma.vipMembership.update({
      where: { userId: input.userId },
      data: {
        totalSpent: { increment: input.amount },
      },
    });
    return {
      userId: updated.userId,
      level: VipLevel.BRONZE,
      lifetimeRecharge: updated.totalSpent,
    };
  }

  async logUpgrade(input: {
    userId: string;
    fromLevel: VipLevel;
    toLevel: VipLevel;
    lifetimeRecharge: bigint;
  }): Promise<void> {
    await this.prisma.vipHistory.create({
      data: {
        userId: input.userId,
        action: 'VIP_UPGRADED',
        details: { from: input.fromLevel, to: input.toLevel },
      },
    });
  }

  async listConfigs() {
    const tiers = await this.prisma.vipTier.findMany({ orderBy: { requiredSpending: 'asc' } });
    return tiers.map((t) => ({
      level: `VIP_${t.level}` as any,
      minRecharge: t.requiredSpending,
      benefits: t.dailyRewards as any,
      createdBy: null,
      updatedBy: null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
  }

  async upsertConfig(
    level: VipLevel,
    data: { minRecharge: bigint; benefits: any },
    _actorId: string,
  ) {
    const numLevel = 1;
    const tier = await this.prisma.vipTier.upsert({
      where: { level: numLevel },
      update: { requiredSpending: data.minRecharge, dailyRewards: data.benefits },
      create: {
        level: numLevel,
        name: `VIP ${numLevel}`,
        requiredSpending: data.minRecharge,
        dailyRewards: data.benefits,
      },
    });
    return {
      level,
      minRecharge: tier.requiredSpending,
      benefits: tier.dailyRewards as any,
      createdBy: null,
      updatedBy: null,
      createdAt: tier.createdAt,
      updatedAt: tier.updatedAt,
    };
  }

  async seedConfig(level: VipLevel, minRecharge: bigint, benefits: any) {
    const count = await this.prisma.vipTier.count();
    if (count > 0) return false;
    await this.prisma.vipTier.create({
      data: { level: 1, name: 'VIP 1', requiredSpending: minRecharge, dailyRewards: benefits },
    });
    return true;
  }
}
