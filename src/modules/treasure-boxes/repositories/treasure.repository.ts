import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TreasureBox,
  TreasureBoxConfig,
  TreasureBoxStatus,
  TreasureRewardKind,
  TreasureSession,
  TreasureSessionStatus,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** A box's contributor totals (for the Top-3 calculation). */
export interface BoxContributorTotal {
  userId: string;
  amount: bigint;
  firstAt: Date;
}

/**
 * Data layer for treasure boxes: the admin box configs, the per-room session +
 * its 5 boxes, the append-only contribution ledger (drives Top-3), and the
 * immutable reward-distribution ledger. Pure persistence — progress/auto-open
 * orchestration and locking live in the service.
 */
@Injectable()
export class TreasureRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Config ----

  listConfigs(): Promise<TreasureBoxConfig[]> {
    return this.prisma.treasureBoxConfig.findMany({ orderBy: { level: 'asc' } });
  }

  listEnabledConfigs(): Promise<TreasureBoxConfig[]> {
    return this.prisma.treasureBoxConfig.findMany({
      where: { enabled: true },
      orderBy: { level: 'asc' },
    });
  }

  getConfig(level: number): Promise<TreasureBoxConfig | null> {
    return this.prisma.treasureBoxConfig.findUnique({ where: { level } });
  }

  upsertConfig(
    level: number,
    data: { threshold: bigint; rewards: Prisma.InputJsonValue; enabled: boolean },
    actorId: string,
  ): Promise<TreasureBoxConfig> {
    return this.prisma.treasureBoxConfig.upsert({
      where: { level },
      create: { level, ...data, ...auditCreate(actorId) },
      update: { ...data, ...auditUpdate(actorId) },
    });
  }

  async seedConfig(
    level: number,
    threshold: bigint,
    rewards: Prisma.InputJsonValue,
  ): Promise<boolean> {
    const exists = await this.prisma.treasureBoxConfig.count({ where: { level } });
    if (exists > 0) return false;
    await this.prisma.treasureBoxConfig.create({
      data: { level, threshold, rewards, enabled: true },
    });
    return true;
  }

  // ---- Session ----

  getActiveSession(roomId: string): Promise<TreasureSession | null> {
    return this.prisma.treasureSession.findFirst({
      where: { roomId, status: TreasureSessionStatus.ACTIVE },
    });
  }

  getSession(id: string): Promise<TreasureSession | null> {
    return this.prisma.treasureSession.findUnique({ where: { id } });
  }

  createSession(roomId: string, startedBy: string, contextType: string): Promise<TreasureSession> {
    return this.prisma.treasureSession.create({ data: { roomId, startedBy, contextType } });
  }

  async setSessionLevel(id: string, currentLevel: number): Promise<void> {
    await this.prisma.treasureSession.update({ where: { id }, data: { currentLevel } });
  }

  async finishSession(id: string, status: TreasureSessionStatus): Promise<void> {
    await this.prisma.treasureSession.update({
      where: { id },
      data: { status, completedAt: new Date() },
    });
  }

  listSessions(roomId: string, skip: number, take: number): Promise<[TreasureSession[], number]> {
    const where: Prisma.TreasureSessionWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.treasureSession.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.treasureSession.count({ where }),
    ]);
  }

  // ---- Boxes ----

  createBox(data: {
    sessionId: string;
    roomId: string;
    level: number;
    threshold: bigint;
    status: TreasureBoxStatus;
  }): Promise<TreasureBox> {
    return this.prisma.treasureBox.create({ data });
  }

  getBox(id: string): Promise<TreasureBox | null> {
    return this.prisma.treasureBox.findUnique({ where: { id } });
  }

  getBoxByLevel(sessionId: string, level: number): Promise<TreasureBox | null> {
    return this.prisma.treasureBox.findUnique({ where: { sessionId_level: { sessionId, level } } });
  }

  listBoxes(sessionId: string): Promise<TreasureBox[]> {
    return this.prisma.treasureBox.findMany({
      where: { sessionId },
      orderBy: { level: 'asc' },
    });
  }

  addProgress(boxId: string, amount: bigint): Promise<TreasureBox> {
    return this.prisma.treasureBox.update({
      where: { id: boxId },
      data: { progress: { increment: amount } },
    });
  }

  async activateBox(boxId: string): Promise<void> {
    await this.prisma.treasureBox.update({
      where: { id: boxId },
      data: { status: TreasureBoxStatus.ACTIVE },
    });
  }

  async openBox(boxId: string, topGifters: Prisma.InputJsonValue): Promise<void> {
    await this.prisma.treasureBox.update({
      where: { id: boxId },
      data: { status: TreasureBoxStatus.OPENED, openedAt: new Date(), topGifters },
    });
  }

  // ---- Contributions ----

  addContribution(data: {
    boxId: string;
    sessionId: string;
    roomId: string;
    userId: string;
    amount: bigint;
    giftTxnId: string | null;
  }): Promise<void> {
    return this.prisma.treasureContribution.create({ data }).then(() => undefined);
  }

  /** Contributor totals for a box, highest first, ties broken by earliest. */
  async topContributors(boxId: string, limit: number): Promise<BoxContributorTotal[]> {
    const grouped = await this.prisma.treasureContribution.groupBy({
      by: ['userId'],
      where: { boxId },
      _sum: { amount: true },
      _min: { createdAt: true },
    });
    return grouped
      .map((g) => ({
        userId: g.userId,
        amount: g._sum.amount ?? 0n,
        firstAt: g._min.createdAt ?? new Date(0),
      }))
      .sort((a, b) => {
        if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
        return a.firstAt.getTime() - b.firstAt.getTime();
      })
      .slice(0, limit);
  }

  // ---- Rewards (immutable) ----

  createReward(data: {
    sessionId: string;
    boxId: string;
    roomId: string;
    level: number;
    userId: string;
    rank: number;
    kind: TreasureRewardKind;
    coins: bigint | null;
    itemType: string | null;
    itemName: string | null;
    walletTxnId: string | null;
    backpackItemId: string | null;
  }): Promise<void> {
    return this.prisma.treasureReward.create({ data }).then(() => undefined);
  }

  listRewards(roomId: string, skip: number, take: number): Promise<[unknown[], number]> {
    const where: Prisma.TreasureRewardWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.treasureReward.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.treasureReward.count({ where }),
    ]);
  }
}
