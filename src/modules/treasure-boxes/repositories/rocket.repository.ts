import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RocketConfig,
  RocketEvent,
  RocketStatus,
  TreasureRewardKind,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { BoxContributorTotal } from './treasure.repository';

/**
 * Data layer for rocket events: admin configs (keyed by trigger gift), the live
 * event + its append-only contribution ledger, and the immutable reward ledger.
 */
@Injectable()
export class RocketRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Config ----

  getConfigByGift(triggerGiftId: string): Promise<RocketConfig | null> {
    return this.prisma.rocketConfig.findUnique({ where: { triggerGiftId } });
  }

  listConfigs(): Promise<RocketConfig[]> {
    return this.prisma.rocketConfig.findMany({ orderBy: { priority: 'desc' } });
  }

  upsertConfig(
    triggerGiftId: string,
    data: {
      durationSeconds: number;
      priority: number;
      rewardPool: Prisma.InputJsonValue;
      enabled: boolean;
    },
    actorId: string,
  ): Promise<RocketConfig> {
    return this.prisma.rocketConfig.upsert({
      where: { triggerGiftId },
      create: { triggerGiftId, ...data, ...auditCreate(actorId) },
      update: { ...data, ...auditUpdate(actorId) },
    });
  }

  // ---- Events ----

  getActiveByRoom(roomId: string): Promise<RocketEvent | null> {
    return this.prisma.rocketEvent.findFirst({
      where: { roomId, status: RocketStatus.ACTIVE },
    });
  }

  getEvent(id: string): Promise<RocketEvent | null> {
    return this.prisma.rocketEvent.findUnique({ where: { id } });
  }

  createEvent(data: {
    roomId: string;
    contextType: string;
    triggerGiftId: string;
    triggeredBy: string;
    endsAt: Date;
  }): Promise<RocketEvent> {
    return this.prisma.rocketEvent.create({ data });
  }

  addProgress(id: string, amount: bigint): Promise<RocketEvent> {
    return this.prisma.rocketEvent.update({
      where: { id },
      data: { totalContribution: { increment: amount } },
    });
  }

  async complete(id: string): Promise<void> {
    await this.prisma.rocketEvent.update({
      where: { id },
      data: { status: RocketStatus.COMPLETED, completedAt: new Date() },
    });
  }

  findExpired(now: Date, take = 100): Promise<RocketEvent[]> {
    return this.prisma.rocketEvent.findMany({
      where: { status: RocketStatus.ACTIVE, endsAt: { lte: now } },
      take,
      orderBy: { endsAt: 'asc' },
    });
  }

  listEvents(roomId: string, skip: number, take: number): Promise<[RocketEvent[], number]> {
    const where: Prisma.RocketEventWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.rocketEvent.findMany({ where, skip, take, orderBy: { startedAt: 'desc' } }),
      this.prisma.rocketEvent.count({ where }),
    ]);
  }

  // ---- Contributions ----

  addContribution(data: {
    rocketId: string;
    roomId: string;
    userId: string;
    amount: bigint;
    giftTxnId: string | null;
  }): Promise<void> {
    return this.prisma.rocketContribution.create({ data }).then(() => undefined);
  }

  /** Contributor totals for a rocket, highest first, ties broken by earliest. */
  async topContributors(rocketId: string, limit: number): Promise<BoxContributorTotal[]> {
    const grouped = await this.prisma.rocketContribution.groupBy({
      by: ['userId'],
      where: { rocketId },
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
    rocketId: string;
    roomId: string;
    userId: string;
    rank: number;
    kind: TreasureRewardKind;
    coins: bigint | null;
    itemType: string | null;
    itemName: string | null;
    walletTxnId: string | null;
    backpackItemId: string | null;
  }): Promise<void> {
    return this.prisma.rocketReward.create({ data }).then(() => undefined);
  }
}
