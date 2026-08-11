import { Injectable } from '@nestjs/common';
import {
  Gift,
  GiftCategory,
  GiftContextType,
  GiftTransaction,
  GiftTxnStatus,
  GiftType,
  Prisma,
} from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  GIFT_LEADERBOARD_MAX_LIMIT,
  LeaderboardBoard,
  LeaderboardScope,
  giftComboKey,
  giftLeaderboardKey,
  giftRateKey,
} from '../constants/gifts.constants';

/** A leaderboard entry (member id + score) resolved from Redis. */
export interface RankedGiftEntry {
  userId: string;
  score: number;
  rank: number;
}

/**
 * Data layer for gifts: the Gift catalog + the append-only gift_transactions
 * ledger (Postgres), plus the Redis combo counter, send-rate limiter and the
 * top-gifter/receiver ZSET leaderboards. Pure persistence — the send pipeline,
 * wallet movements and broadcasts live in the service.
 */
@Injectable()
export class GiftRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ---- Catalog ----

  getGift(id: string): Promise<Gift | null> {
    return this.prisma.gift.findUnique({ where: { id } });
  }

  listActiveGifts(filter: { category?: GiftCategory; type?: GiftType } = {}): Promise<Gift[]> {
    return this.prisma.gift.findMany({
      where: {
        enabled: true,
        ...(filter.category ? { category: filter.category } : {}),
        ...(filter.type ? { type: filter.type } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { coinValue: 'asc' }],
    });
  }

  listGifts(
    skip: number,
    take: number,
    filter: { category?: GiftCategory; enabled?: boolean },
  ): Promise<[Gift[], number]> {
    const where: Prisma.GiftWhereInput = {
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.gift.findMany({ where, skip, take, orderBy: { sortOrder: 'asc' } }),
      this.prisma.gift.count({ where }),
    ]);
  }

  createGift(data: Prisma.GiftUncheckedCreateInput, actorId: string): Promise<Gift> {
    return this.prisma.gift.create({ data: { ...data, ...auditCreate(actorId) } });
  }

  updateGift(id: string, data: Prisma.GiftUpdateInput, actorId: string): Promise<Gift> {
    return this.prisma.gift.update({ where: { id }, data: { ...data, ...auditUpdate(actorId) } });
  }

  async countByName(name: string): Promise<number> {
    return this.prisma.gift.count({ where: { name } });
  }

  // ---- Gift ledger (immutable) ----

  findTxnByIdempotencyKey(
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<GiftTransaction | null> {
    const client = tx || this.prisma;
    return client.giftTransaction.findUnique({ where: { idempotencyKey } });
  }

  createTransaction(
    data: {
      senderId: string;
      receiverId: string;
      giftId: string;
      giftType: GiftType;
      contextType: GiftContextType;
      contextId: string;
      quantity: number;
      comboTier: number;
      unitCoinValue: number;
      totalCoinValue: bigint;
      creatorEarnings: bigint;
      cashbackAmount: bigint;
      appliedEarningsPct: number;
      appliedCashbackPct: number;
      luckyMultiplier: number;
      isLuckyWin: boolean;
      senderExp: number;
      receiverExp: number;
      idempotencyKey: string;
      senderWalletTxnId: string | null;
      receiverWalletTxnId: string | null;
      metadata?: Prisma.InputJsonValue;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<GiftTransaction> {
    const client = tx || this.prisma;
    return client.giftTransaction.create({
      data: { ...data, status: GiftTxnStatus.COMPLETED },
    });
  }

  listTransactions(
    where: Prisma.GiftTransactionWhereInput,
    skip: number,
    take: number,
  ): Promise<[GiftTransaction[], number]> {
    return this.prisma.$transaction([
      this.prisma.giftTransaction.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.giftTransaction.count({ where }),
    ]);
  }

  /**
   * Gift count + most-recent-gift timestamp per sender, for a set of senders
   * gifting one receiver within a window — hydrates a leaderboard's ZSET rows
   * (score/rank only) with the extra display fields Top Fans needs.
   */
  async fanStatsFor(
    receiverId: string,
    senderIds: string[],
    since: Date | null,
  ): Promise<Map<string, { count: number; lastGiftAt: Date }>> {
    if (senderIds.length === 0) return new Map();
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['senderId'],
      where: {
        receiverId,
        senderId: { in: senderIds },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return new Map(
      rows
        .filter((r) => r._max.createdAt !== null)
        .map((r) => [r.senderId, { count: r._count._all, lastGiftAt: r._max.createdAt! }]),
    );
  }

  /** Total gift coins received in a context (e.g. a room) within a time window. */
  async sumContextCoinsInRange(
    contextType: GiftContextType,
    contextId: string,
    start: Date,
    end: Date,
  ): Promise<bigint> {
    const result = await this.prisma.giftTransaction.aggregate({
      where: { contextType, contextId, createdAt: { gte: start, lte: end } },
      _sum: { totalCoinValue: true },
    });
    return result._sum.totalCoinValue ?? 0n;
  }

  // ---- Redis: combo + rate limit ----

  /**
   * Increment the combo counter for (context, sender, gift). Returns the new
   * tier; the TTL is the gift's combo window so a lapse resets to 1.
   */
  comboTick(
    contextId: string,
    senderId: string,
    giftId: string,
    windowSeconds: number,
  ): Promise<number> {
    return this.cache.increment(giftComboKey(contextId, senderId, giftId), {
      ttlSeconds: windowSeconds,
    });
  }

  /** Increment the rolling send-rate window; true when the cap is exceeded. */
  async hitRateLimit(senderId: string, max: number, windowSeconds: number): Promise<boolean> {
    const count = await this.cache.increment(giftRateKey(senderId), { ttlSeconds: windowSeconds });
    return count > max;
  }

  // ---- Redis: leaderboards ----

  /** Add `amount` to a user's score on a leaderboard ZSET (creates with TTL). */
  async addLeaderboardScore(
    board: LeaderboardBoard,
    scope: LeaderboardScope,
    scopeId: string | null,
    bucket: string,
    userId: string,
    amount: number,
    ttlSeconds: number,
  ): Promise<void> {
    const key = giftLeaderboardKey(board, scope, scopeId, bucket);
    await this.cache.addScore(key, userId, amount);
    await this.cache.expire(key, ttlSeconds);
  }

  /** Top N entries of a leaderboard, highest score first. */
  async topLeaderboard(
    board: LeaderboardBoard,
    scope: LeaderboardScope,
    scopeId: string | null,
    bucket: string,
    limit: number,
  ): Promise<RankedGiftEntry[]> {
    const key = giftLeaderboardKey(board, scope, scopeId, bucket);
    const entries = await this.cache.top(key, Math.min(limit, GIFT_LEADERBOARD_MAX_LIMIT));
    return entries.map((e, i) => ({ userId: e.member, score: e.score, rank: i + 1 }));
  }
}
