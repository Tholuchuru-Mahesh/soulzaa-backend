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

  /** Idempotent seed helper: insert a gift only if the name is new. */
  async seedGift(data: Prisma.GiftUncheckedCreateInput): Promise<boolean> {
    const exists = await this.prisma.gift.count({ where: { name: data.name } });
    if (exists > 0) return false;
    await this.prisma.gift.create({ data });
    return true;
  }

  // ---- Gift ledger (immutable) ----

  findTxnByIdempotencyKey(idempotencyKey: string): Promise<GiftTransaction | null> {
    return this.prisma.giftTransaction.findUnique({ where: { idempotencyKey } });
  }

  createTransaction(data: {
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
    luckyMultiplier: number;
    isLuckyWin: boolean;
    senderExp: number;
    receiverExp: number;
    idempotencyKey: string;
    senderWalletTxnId: string | null;
    receiverWalletTxnId: string | null;
    metadata?: Prisma.InputJsonValue;
  }): Promise<GiftTransaction> {
    return this.prisma.giftTransaction.create({
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
