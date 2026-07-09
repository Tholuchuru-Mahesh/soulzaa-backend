import { Injectable } from '@nestjs/common';
import {
  ExpLog,
  ExpSource,
  LevelConfig,
  Prisma,
  RoomExp,
  RoomLevelConfig,
  UserExp,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Data layer for EXP & levels: the user/room EXP aggregates, the append-only
 * EXP ledgers, and the admin level configs. The award read-modify-write is done
 * transactionally in `applyUserExp`/`applyRoomExp`; the service serialises
 * callers per-user/room with a lock.
 */
@Injectable()
export class ExpRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- User EXP ----

  getUserExp(userId: string): Promise<UserExp | null> {
    return this.prisma.userExp.findUnique({ where: { userId } });
  }

  findUserLog(idempotencyKey: string): Promise<ExpLog | null> {
    return this.prisma.expLog.findUnique({ where: { idempotencyKey } });
  }

  /** Apply a user EXP delta + ledger row atomically; returns the new total + level. */
  applyUserExp(input: {
    userId: string;
    amount: number;
    source: ExpSource;
    referenceType: string | null;
    referenceId: string | null;
    idempotencyKey: string;
    newLevel: number;
  }): Promise<UserExp> {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.userExp.upsert({
        where: { userId: input.userId },
        create: { userId: input.userId },
        update: {},
      });
      const totalAfter = wallet.totalExp + BigInt(input.amount);
      const updated = await tx.userExp.update({
        where: { userId: input.userId },
        data: { totalExp: totalAfter, level: input.newLevel },
      });
      await tx.expLog.create({
        data: {
          userId: input.userId,
          amount: input.amount,
          source: input.source,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          idempotencyKey: input.idempotencyKey,
          totalAfter,
        },
      });
      return updated;
    });
  }

  listUserLogs(userId: string, skip: number, take: number): Promise<[ExpLog[], number]> {
    const where: Prisma.ExpLogWhereInput = { userId };
    return this.prisma.$transaction([
      this.prisma.expLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.expLog.count({ where }),
    ]);
  }

  // ---- Room EXP ----

  getRoomExp(roomId: string): Promise<RoomExp | null> {
    return this.prisma.roomExp.findUnique({ where: { roomId } });
  }

  findRoomLog(idempotencyKey: string): Promise<{ id: string } | null> {
    return this.prisma.roomExpLog.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
  }

  applyRoomExp(input: {
    roomId: string;
    amount: number;
    source: ExpSource;
    referenceId: string | null;
    idempotencyKey: string;
    newLevel: number;
  }): Promise<RoomExp> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.roomExp.upsert({
        where: { roomId: input.roomId },
        create: { roomId: input.roomId },
        update: {},
      });
      const totalAfter = row.totalExp + BigInt(input.amount);
      const updated = await tx.roomExp.update({
        where: { roomId: input.roomId },
        data: { totalExp: totalAfter, level: input.newLevel },
      });
      await tx.roomExpLog.create({
        data: {
          roomId: input.roomId,
          amount: input.amount,
          source: input.source,
          referenceId: input.referenceId,
          idempotencyKey: input.idempotencyKey,
          totalAfter,
        },
      });
      return updated;
    });
  }

  // ---- Level configs ----

  listLevelConfigs(): Promise<LevelConfig[]> {
    return this.prisma.levelConfig.findMany({ orderBy: { level: 'asc' } });
  }

  listRoomLevelConfigs(): Promise<RoomLevelConfig[]> {
    return this.prisma.roomLevelConfig.findMany({ orderBy: { level: 'asc' } });
  }

  upsertLevelConfig(
    level: number,
    data: { minExp: bigint; title: string | null; rewards: Prisma.InputJsonValue },
    actorId: string,
  ): Promise<LevelConfig> {
    return this.prisma.levelConfig.upsert({
      where: { level },
      create: { level, ...data, ...auditCreate(actorId) },
      update: { ...data, ...auditUpdate(actorId) },
    });
  }

  upsertRoomLevelConfig(
    level: number,
    data: { minExp: bigint; title: string | null },
    actorId: string,
  ): Promise<RoomLevelConfig> {
    return this.prisma.roomLevelConfig.upsert({
      where: { level },
      create: { level, ...data, ...auditCreate(actorId) },
      update: { ...data, ...auditUpdate(actorId) },
    });
  }

  async seedLevelConfig(
    level: number,
    minExp: bigint,
    title: string,
    rewards: Prisma.InputJsonValue,
  ): Promise<boolean> {
    const exists = await this.prisma.levelConfig.count({ where: { level } });
    if (exists > 0) return false;
    await this.prisma.levelConfig.create({ data: { level, minExp, title, rewards } });
    return true;
  }

  async seedRoomLevelConfig(level: number, minExp: bigint, title: string): Promise<boolean> {
    const exists = await this.prisma.roomLevelConfig.count({ where: { level } });
    if (exists > 0) return false;
    await this.prisma.roomLevelConfig.create({ data: { level, minExp, title } });
    return true;
  }
}
