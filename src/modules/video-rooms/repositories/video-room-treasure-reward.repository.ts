import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TreasureRewardKind,
  TreasureRewardPool,
  TreasureRewardStatus,
  TreasureWinner,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** True when the error is a unique-constraint violation — i.e. the replay guard. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Persistence for minted pools, drawn winners and distributed rewards (VR-11).
 *
 * The unique constraints (`TreasureRewardPool.boxId`,
 * `TreasureWinner(boxId, userId)`) are the primary duplicate-reward defence,
 * and this repository translates them into ordinary control flow: a replayed
 * unlock gets `null` or a skipped insert rather than an exception. Enforcing
 * that in application code instead would leave a window two BullMQ workers can
 * both pass through — no amount of `if (alreadyExists)` closes it.
 */
@Injectable()
export class VideoRoomTreasureRewardRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Pool ----

  /** Returns null when this box already has a pool — i.e. this is a replay. */
  async createPool(
    input: {
      boxId: string;
      sessionId: string;
      roomId: string;
      level: number;
      strategy: string;
      sourceAmount: bigint;
      poolAmount: bigint;
      winnerCount: number;
      algorithm: string;
      algorithmVersion: number;
      selectionSeed: string;
    },
    tx: Db,
  ): Promise<TreasureRewardPool | null> {
    try {
      return await tx.treasureRewardPool.create({ data: input });
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  getPool(boxId: string): Promise<TreasureRewardPool | null> {
    return this.prisma.treasureRewardPool.findUnique({ where: { boxId } });
  }

  async setAllocated(boxId: string, allocated: bigint, tx: Db): Promise<void> {
    await tx.treasureRewardPool.update({
      where: { boxId },
      data: { allocatedAmount: allocated },
    });
  }

  // ---- Winners ----

  /** `skipDuplicates` makes a replayed draw a no-op rather than a crash. */
  async createWinners(
    rows: {
      boxId: string;
      sessionId: string;
      roomId: string;
      userId: string;
      algorithm: string;
      shareBps: number;
      amount: bigint;
      eligibleCount: number;
      candidateCount: number;
    }[],
    tx: Db,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await tx.treasureWinner.createMany({ data: rows, skipDuplicates: true });
    return res.count;
  }

  listWinners(roomId: string, skip: number, take: number): Promise<[TreasureWinner[], number]> {
    const where: Prisma.TreasureWinnerWhereInput = { roomId };
    return this.prisma.$transaction([
      this.prisma.treasureWinner.findMany({ where, skip, take, orderBy: { selectedAt: 'desc' } }),
      this.prisma.treasureWinner.count({ where }),
    ]);
  }

  listWinnersByBox(boxId: string): Promise<TreasureWinner[]> {
    return this.prisma.treasureWinner.findMany({ where: { boxId } });
  }

  // ---- Reward rows ----

  async createPendingRewards(
    rows: {
      sessionId: string;
      boxId: string;
      roomId: string;
      level: number;
      userId: string;
      rank: number;
      coins: bigint;
    }[],
    tx: Db,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.treasureReward.createMany({
      data: rows.map((r) => ({
        ...r,
        kind: TreasureRewardKind.COINS,
        status: TreasureRewardStatus.PENDING,
      })),
    });
  }

  async markDistributed(
    boxId: string,
    userId: string,
    walletTxnId: string | null,
    tx: Db,
  ): Promise<void> {
    await tx.treasureReward.updateMany({
      where: { boxId, userId, status: TreasureRewardStatus.PENDING },
      data: {
        status: TreasureRewardStatus.DISTRIBUTED,
        walletTxnId,
        distributedAt: new Date(),
      },
    });
  }

  /**
   * Records a failed attempt. Deliberately NOT taking a `tx`: the unlock
   * transaction is rolling back when this runs, so a write inside it would
   * vanish along with the very failure record we need to debug from.
   */
  async markFailed(boxId: string, stage: string, error: string): Promise<void> {
    await this.prisma.treasureReward.updateMany({
      where: { boxId, status: TreasureRewardStatus.PENDING },
      data: {
        status: TreasureRewardStatus.FAILED,
        failureStage: stage,
        lastError: error.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
  }

  // ---- Statistics ----

  async statistics(roomId: string): Promise<{
    totalPools: number;
    totalMinted: bigint;
    totalWinners: number;
  }> {
    const [pools, minted, winners] = await this.prisma.$transaction([
      this.prisma.treasureRewardPool.count({ where: { roomId } }),
      this.prisma.treasureRewardPool.aggregate({
        where: { roomId },
        _sum: { allocatedAmount: true },
      }),
      this.prisma.treasureWinner.count({ where: { roomId } }),
    ]);
    return {
      totalPools: pools,
      totalMinted: minted._sum.allocatedAmount ?? 0n,
      totalWinners: winners,
    };
  }
}
