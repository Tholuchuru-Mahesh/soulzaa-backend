import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class ExpRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getUserExp(userId: string) {
    const ul = await this.prisma.userLevel.findUnique({ where: { userId } });
    if (!ul) return null;
    return {
      userId: ul.userId,
      totalExp: ul.lifetimeExp,
      level: ul.currentLevel,
      updatedAt: ul.updatedAt,
    };
  }

  async findUserLog(idempotencyKey: string) {
    const h = await this.prisma.experienceHistory.findUnique({ where: { idempotencyKey } });
    if (!h) return null;
    return {
      id: h.id,
      userId: h.userId,
      amount: h.amount,
      source: h.sourceCode as any,
      referenceType: h.referenceType,
      referenceId: h.referenceId as any,
      idempotencyKey: h.idempotencyKey,
      totalAfter: h.totalExpAfter,
      createdAt: h.createdAt,
    };
  }

  async applyUserExp(input: {
    userId: string;
    amount: number;
    source: any;
    referenceType: string | null;
    referenceId: string | null;
    idempotencyKey: string;
    newLevel: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.userLevel.upsert({
        where: { userId: input.userId },
        create: {
          userId: input.userId,
          currentLevel: input.newLevel,
          lifetimeExp: BigInt(input.amount),
        },
        update: {
          currentLevel: input.newLevel,
          lifetimeExp: { increment: BigInt(input.amount) },
        },
      });

      await tx.experienceHistory.create({
        data: {
          userId: input.userId,
          amount: input.amount,
          sourceCode: String(input.source),
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          idempotencyKey: input.idempotencyKey,
          previousLevel: 1,
          newLevel: input.newLevel,
          totalExpAfter: updated.lifetimeExp,
        },
      });

      return {
        userId: updated.userId,
        totalExp: updated.lifetimeExp,
        level: updated.currentLevel,
        updatedAt: updated.updatedAt,
      };
    });
  }

  async listUserLogs(userId: string, skip: number, take: number) {
    const where = { userId };
    const [histories, count] = await Promise.all([
      this.prisma.experienceHistory.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.experienceHistory.count({ where }),
    ]);

    const mapped = histories.map((h) => ({
      id: h.id,
      userId: h.userId,
      amount: h.amount,
      source: h.sourceCode as any,
      referenceType: h.referenceType,
      referenceId: h.referenceId as any,
      idempotencyKey: h.idempotencyKey,
      totalAfter: h.totalExpAfter,
      createdAt: h.createdAt,
    }));

    return [mapped, count] as [any[], number];
  }

  async listLevelConfigs() {
    const defs = await this.prisma.levelDefinition.findMany({ orderBy: { level: 'asc' } });
    return defs.map((d) => ({
      level: d.level,
      minExp: d.requiredExp,
      title: d.title,
      rewards: [],
      createdBy: null,
      updatedBy: null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));
  }

  async upsertLevelConfig(
    level: number,
    data: { minExp: bigint; title: string | null; rewards: any },
    _actorId: string,
  ) {
    const def = await this.prisma.levelDefinition.upsert({
      where: { level },
      update: { requiredExp: data.minExp, title: data.title },
      create: { level, requiredExp: data.minExp, title: data.title },
    });
    return {
      level: def.level,
      minExp: def.requiredExp,
      title: def.title,
      rewards: [],
      createdBy: null,
      updatedBy: null,
      createdAt: def.createdAt,
      updatedAt: def.updatedAt,
    };
  }

  async seedLevelConfig(
    level: number,
    minExp: bigint,
    title: string,
    _rewards: any,
  ): Promise<boolean> {
    const exists = await this.prisma.levelDefinition.count({ where: { level } });
    if (exists > 0) return false;
    await this.prisma.levelDefinition.create({ data: { level, requiredExp: minExp, title } });
    return true;
  }
}
