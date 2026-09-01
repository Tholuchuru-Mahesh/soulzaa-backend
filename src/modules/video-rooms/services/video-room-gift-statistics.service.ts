import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type GiftTransaction } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import { REDIS_CLIENT, type RedisClient } from 'src/infra/redis/redis.constants';
import { loadVideoRoomGiftConfig } from '../config/video-room-gift.config';
import { VideoRoomGiftRepository } from '../repositories/video-room-gift.repository';
import {
  GIFT_STATS_FIELD,
  giftRecentKey,
  giftStatsKey,
  giftTopKey,
  giftTopSendersKey,
} from '../constants/video-room-gift.constants';

/** Room-level gift totals, cheap enough for any member to read. */
export interface VideoRoomGiftSummary {
  totalGifts: number;
  totalGiftCoins: number;
  topGifts: { giftId: string; count: number }[];
  topSenders: { userId: string; coins: number; username?: string; avatarUrl?: string }[];
}

/** Analytics breakdown, gated behind VIEW_ANALYTICS. */
export interface VideoRoomGiftBreakdown extends VideoRoomGiftSummary {
  receiverEarnings: { receiverId: string; coins: number; gifts: number }[];
  senderTotals: { senderId: string; coins: number; gifts: number }[];
  uniqueSenders: number;
}

/** One entry of the recent-gift feed. */
export interface VideoRoomRecentGift {
  transactionId: string;
  batchId: string;
  senderId: string;
  receiverId: string;
  giftId: string;
  giftName: string;
  quantity: number;
  comboTier: number;
  totalCoinValue: number;
  createdAt: string;
}

/**
 * Gift statistics for a video room (VR-10).
 *
 * Three tiers, deliberately: durable counters on `video_room_statistics` (the
 * columns already existed and were never written), hot Redis counters and
 * ZSETs for the live view, and on-demand aggregation over `gift_transactions`
 * for the analytics breakdown. No rollup table — the ledger is already the
 * source of truth, and a fourth copy of the same numbers is a fourth thing that
 * can disagree.
 */
@Injectable()
export class VideoRoomGiftStatisticsService {
  private readonly logger = new Logger(VideoRoomGiftStatisticsService.name);

  constructor(
    private readonly repo: VideoRoomGiftRepository,
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * Record a committed batch. Runs strictly AFTER the send transaction: every
   * write here is Redis or a non-transactional counter update, and none of it
   * can be rolled back — which is exactly why it must not run inside the
   * transaction.
   */
  async record(roomId: string, txns: GiftTransaction[]): Promise<void> {
    if (txns.length === 0) return;
    const coins = txns.reduce((sum, t) => sum + BigInt(t.totalCoinValue), 0n);

    await this.incrementDurableTotals(roomId, txns.length, coins);
    await this.updateHotCounters(roomId, txns, Number(coins));
    await this.pushRecent(roomId, txns);
  }

  /** Durable per-room counters — the columns VR-1 created and nothing wrote. */
  private async incrementDurableTotals(
    roomId: string,
    giftCount: number,
    coins: bigint,
  ): Promise<void> {
    try {
      await this.repo.incrementGiftTotals(roomId, giftCount, coins);
    } catch (err) {
      // Statistics must never fail a send that already committed.
      this.logger.warn(
        `failed to increment gift totals for room ${roomId}: ${(err as Error).message}`,
      );
    }
  }

  private async updateHotCounters(
    roomId: string,
    txns: GiftTransaction[],
    coins: number,
  ): Promise<void> {
    await this.redis.hincrby(giftStatsKey(roomId), GIFT_STATS_FIELD.COUNT, txns.length);
    await this.redis.hincrby(giftStatsKey(roomId), GIFT_STATS_FIELD.COINS, coins);
    for (const txn of txns) {
      // Top gifts ranks by how often a gift is sent; top senders by coins spent.
      await this.cache.addScore(giftTopKey(roomId), txn.giftId, 1);
      await this.cache.addScore(
        giftTopSendersKey(roomId),
        txn.senderId,
        Number(txn.totalCoinValue),
      );
    }
  }

  /** Newest-first capped feed. LPUSH + LTRIM keeps it O(1) and bounded. */
  private async pushRecent(roomId: string, txns: GiftTransaction[]): Promise<void> {
    const size = loadVideoRoomGiftConfig(this.config).recentFeedSize;
    const key = giftRecentKey(roomId);
    const entries = txns.map((txn) =>
      JSON.stringify({
        transactionId: txn.id,
        batchId: (txn.metadata as { batchId?: string } | null)?.batchId ?? txn.id,
        senderId: txn.senderId,
        receiverId: txn.receiverId,
        giftId: txn.giftId,
        giftName: (txn.metadata as { giftName?: string } | null)?.giftName ?? '',
        quantity: txn.quantity,
        comboTier: txn.comboTier,
        totalCoinValue: Number(txn.totalCoinValue),
        createdAt: txn.createdAt.toISOString(),
      } satisfies VideoRoomRecentGift),
    );
    await this.redis.lpush(key, ...entries);
    await this.redis.ltrim(key, 0, size - 1);
  }

  /** The recent-gift feed, newest first. Redis-only — never hits Postgres. */
  async recent(roomId: string): Promise<VideoRoomRecentGift[]> {
    const size = loadVideoRoomGiftConfig(this.config).recentFeedSize;
    const raw = await this.redis.lrange(giftRecentKey(roomId), 0, size - 1);
    return raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as VideoRoomRecentGift;
        } catch {
          return null;
        }
      })
      .filter((e): e is VideoRoomRecentGift => e !== null);
  }

  /** Durable totals + live top lists, reconciled with ledger aggregates. */
  async summary(roomId: string): Promise<VideoRoomGiftSummary> {
    const stats = await this.repo.findStatistics(roomId);
    const [topGifts, topSenders, ledgerAgg] = await Promise.all([
      this.cache.top(giftTopKey(roomId), 10),
      this.cache.top(giftTopSendersKey(roomId), 10),
      this.repo.aggregateBySender(roomId),
    ]);

    const ledgerGifts = ledgerAgg.reduce((sum, r) => sum + r.gifts, 0);
    const ledgerCoins = ledgerAgg.reduce((sum, r) => sum + r.coins, 0);

    let effectiveSenders = topSenders.map((e) => ({
      userId: e.member,
      coins: e.score,
      username: undefined as string | undefined,
      avatarUrl: undefined as string | undefined,
    }));

    if (ledgerAgg.length > 0) {
      const topLedger = [...ledgerAgg].sort((a, b) => b.coins - a.coins).slice(0, 10);
      effectiveSenders = topLedger.map((r) => ({
        userId: r.senderId,
        coins: r.coins,
        username: r.username,
        avatarUrl: r.avatarUrl,
      }));
    }

    return {
      totalGifts: Math.max(Number(stats?.totalGifts ?? 0), ledgerGifts),
      totalGiftCoins: Math.max(Number(stats?.totalGiftCoins ?? 0), ledgerCoins),
      topGifts: topGifts.map((e) => ({ giftId: e.member, count: e.score })),
      topSenders: effectiveSenders,
    };
  }

  /**
   * Analytics breakdown, aggregated from the ledger rather than a rollup table.
   * The repository scopes every aggregate to this room's VIDEO_ROOM rows, which
   * the `[contextType, contextId, createdAt]` index already serves.
   */
  async breakdown(roomId: string): Promise<VideoRoomGiftBreakdown> {
    const [summary, byReceiver, bySender] = await Promise.all([
      this.summary(roomId),
      this.repo.aggregateByReceiver(roomId),
      this.repo.aggregateBySender(roomId),
    ]);

    return {
      ...summary,
      receiverEarnings: byReceiver.map((row) => ({
        receiverId: row.receiverId,
        coins: row.earnings,
        gifts: row.gifts,
      })),
      senderTotals: bySender.map((row) => ({
        senderId: row.senderId,
        coins: row.coins,
        gifts: row.gifts,
      })),
      uniqueSenders: bySender.length,
    };
  }
}
