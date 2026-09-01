import { Injectable } from '@nestjs/common';
import {
  GiftContextType,
  GiftTxnStatus,
  Prisma,
  type GiftTransaction,
  type VideoRoomStatistics,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Per-receiver aggregate over a room's gift ledger. */
export interface GiftReceiverAggregate {
  receiverId: string;
  earnings: number;
  coins: number;
  gifts: number;
}

/** Per-sender aggregate over a room's gift ledger. */
export interface GiftSenderAggregate {
  senderId: string;
  coins: number;
  gifts: number;
}

/**
 * Persistence for VR-10 gift reads and counters. Pure Prisma — no business
 * rules, no Redis, no events.
 *
 * This exists because the phase brief is explicit that services must not touch
 * Prisma directly. Every aggregate here is scoped to `contextType = VIDEO_ROOM`
 * so a room's gift analytics can never accidentally read audio-room rows.
 */
@Injectable()
export class VideoRoomGiftRepository {
  constructor(private readonly prisma: PrismaService) {}

  private roomScope(roomId: string): Prisma.GiftTransactionWhereInput {
    return { contextType: GiftContextType.VIDEO_ROOM, contextId: roomId };
  }

  // ---- Durable room counters ----

  /**
   * Add a committed batch to the room's lifetime gift counters. Called after
   * the send transaction commits, so it is deliberately a separate write.
   */
  async incrementGiftTotals(roomId: string, giftCount: number, coins: bigint): Promise<void> {
    await this.prisma.videoRoomStatistics.upsert({
      where: { roomId },
      create: {
        roomId,
        totalGifts: BigInt(giftCount),
        totalGiftCoins: coins,
        lastActivityAt: new Date(),
      },
      update: {
        totalGifts: { increment: BigInt(giftCount) },
        totalGiftCoins: { increment: coins },
        lastActivityAt: new Date(),
      },
    });
  }

  findStatistics(roomId: string): Promise<VideoRoomStatistics | null> {
    return this.prisma.videoRoomStatistics.findUnique({ where: { roomId } });
  }

  // ---- Ledger aggregates ----

  async aggregateByReceiver(roomId: string): Promise<GiftReceiverAggregate[]> {
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['receiverId'],
      where: {
        ...this.roomScope(roomId),
        status: GiftTxnStatus.COMPLETED,
      },
      _sum: { creatorEarnings: true, totalCoinValue: true },
      _count: { _all: true },
    });
    return rows.map((row) => ({
      receiverId: row.receiverId,
      earnings: Number(row._sum.creatorEarnings ?? 0),
      coins: Number(row._sum.totalCoinValue ?? 0),
      gifts: row._count._all,
    }));
  }

  async aggregateBySender(
    roomId: string,
  ): Promise<(GiftSenderAggregate & { username?: string; avatarUrl?: string })[]> {
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['senderId'],
      where: {
        ...this.roomScope(roomId),
        status: GiftTxnStatus.COMPLETED,
      },
      _sum: { totalCoinValue: true },
      _count: { _all: true },
    });

    const userIds = rows.map((r) => r.senderId);
    const users = userIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    return rows.map((row) => ({
      senderId: row.senderId,
      coins: Number(row._sum.totalCoinValue ?? 0),
      gifts: row._count._all,
      username: userMap.get(row.senderId)?.username,
    }));
  }

  // ---- Reversal / adjustment support ----

  /** A single VIDEO_ROOM gift transaction, scoped so admins cannot reverse an audio gift here. */
  findRoomTransaction(roomId: string, transactionId: string): Promise<GiftTransaction | null> {
    return this.prisma.giftTransaction.findFirst({
      where: { ...this.roomScope(roomId), id: transactionId },
    });
  }

  /** Every leg of a batch, so a multi-receiver send reverses as a unit. */
  findBatch(roomId: string, batchId: string): Promise<GiftTransaction[]> {
    return this.prisma.giftTransaction.findMany({
      where: {
        ...this.roomScope(roomId),
        metadata: { path: ['batchId'], equals: batchId },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Mark a transaction REVERSED.
   *
   * Conditional on it still being COMPLETED, so two concurrent reversals cannot
   * both succeed and double-refund — the second updates zero rows and the caller
   * sees `false`. This is the same conditional-update guard the module uses for
   * seat and stream state.
   *
   * The existing metadata is MERGED, not replaced: Prisma has no partial-JSON
   * update, and blowing the column away would lose `batchId` and `giftName`,
   * silently breaking batch correlation and the recent-gift feed for that row.
   */
  async markReversed(
    transactionId: string,
    reason: string,
    actorId: string,
    existingMetadata: Prisma.JsonValue | null,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.prisma;
    const base =
      existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
        ? (existingMetadata as Record<string, unknown>)
        : {};

    const result = await client.giftTransaction.updateMany({
      where: { id: transactionId, status: GiftTxnStatus.COMPLETED },
      data: {
        status: GiftTxnStatus.REVERSED,
        metadata: {
          ...base,
          reversedBy: actorId,
          reversedAt: new Date().toISOString(),
          reversalReason: reason,
        } as Prisma.InputJsonValue,
      },
    });
    return result.count === 1;
  }
}
