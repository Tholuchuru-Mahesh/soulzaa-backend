import { Injectable } from '@nestjs/common';
import {
  GiftContextType,
  GiftTxnStatus,
  Prisma,
  VideoRoomPkStatus,
  type VideoRoomLeaderboardSnapshot,
  type VideoRoomRankingSnapshot,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface AggregationWindow {
  start: Date;
  end: Date;
}

export interface RankingLadderKey {
  scope: string;
  dimension: string;
  period: string;
  dateKey: string;
}

export interface LeaderboardSnapshotInput extends RankingLadderKey {
  entries: Prisma.InputJsonValue;
  totalEntries: number;
}

export interface AggregationStats {
  sourceRows: number;
  entriesWritten: number;
  durationMs: number;
}

/** Display data resolved for one ladder member — the "hydrate the top-N" read. */
export interface HydratedTarget {
  id: string;
  username: string;
  avatarKey: string | null;
  level: number;
  vipLevel: number;
}

/**
 * The only place VR-13 touches Prisma (enforced by dependency-cruiser).
 *
 * Two distinct responsibilities live here and are kept visually separate: the
 * three VR-13 tables, and read-only aggregate queries over OTHER modules'
 * source tables. The latter is what makes the recompute authoritative — it
 * recounts from gift_transactions / PK / treasure rather than trusting an
 * accumulated Redis score — and it is deliberately read-only: VR-13 never
 * writes another domain's table.
 */
@Injectable()
export class VideoRoomRankingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ================= geography =================

  /**
   * Country lives on `User`, city on `UserProfile` — two tables, so two queries
   * joined in memory. Done as a single `$transaction` so both reads see one
   * snapshot, and batched by id because this is called with a whole ladder's
   * worth of users during recompute.
   */
  async findUserGeo(
    userIds: string[],
  ): Promise<{ userId: string; country: string | null; city: string | null }[]> {
    if (userIds.length === 0) return [];
    const [users, profiles] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, country: true },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, city: true },
      }),
    ]);
    const cityById = new Map(profiles.map((p) => [p.userId, p.city]));
    return users.map((u) => ({
      userId: u.id,
      country: u.country ?? null,
      city: cityById.get(u.id) ?? null,
    }));
  }

  /**
   * Resolves display data for a ladder's members in one pass. `kind` selects
   * the table because a `rooms` ladder holds ROOM ids — looking those up
   * against `user` would silently return nothing.
   *
   * For 'user': `user` (id, username), `userProfile` (avatarKey) and
   * `userStatistics` (level, vipLevel) are read in a single `$transaction`
   * and joined in memory; a missing profile/statistics row defaults to
   * avatarKey null, level 1, vipLevel 0 (matching UserStatistics' own column
   * defaults).
   *
   * For 'room': `VideoRoom` (id, name, imageKey) is read directly — name maps
   * to `username`, `imageKey` (the room's cover-image S3 key) maps to
   * `avatarKey` — with level/vipLevel fixed at 0 (rooms don't have either).
   */
  async hydrateTargets(ids: string[], kind: 'user' | 'room'): Promise<HydratedTarget[]> {
    if (ids.length === 0) return [];

    if (kind === 'room') {
      const rooms = await this.prisma.videoRoom.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, imageKey: true },
      });
      return rooms.map((r) => ({
        id: r.id,
        username: r.name,
        avatarKey: r.imageKey ?? null,
        level: 0,
        vipLevel: 0,
      }));
    }

    const [users, profiles, stats] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, username: true },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, avatarKey: true },
      }),
      this.prisma.userStatistics.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, level: true, wealthLevel: true },
      }),
    ]);
    const avatarByUser = new Map(profiles.map((p) => [p.userId, p.avatarKey]));
    const statsByUser = new Map(stats.map((s) => [s.userId, s]));
    return users.map((u) => {
      const stat = statsByUser.get(u.id);
      return {
        id: u.id,
        username: u.username,
        avatarKey: avatarByUser.get(u.id) ?? null,
        level: stat?.level ?? 1,
        vipLevel: stat?.wealthLevel ?? 0,
      };
    });
  }

  // ================= ranking snapshots =================

  /**
   * `skipDuplicates` against the (scope,dimension,period,dateKey,targetId)
   * unique key is what makes a replayed snapshot job a no-op instead of a
   * constraint violation.
   */
  async saveRankingSnapshots(
    rows: Prisma.VideoRoomRankingSnapshotCreateManyInput[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.videoRoomRankingSnapshot.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return count;
  }

  async findRankingSnapshots(
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    skip: number,
    take: number,
  ): Promise<[VideoRoomRankingSnapshot[], number]> {
    const where = { scope, dimension, period, dateKey };
    return this.prisma.$transaction([
      this.prisma.videoRoomRankingSnapshot.findMany({
        where,
        skip,
        take,
        orderBy: { rank: 'asc' },
      }),
      this.prisma.videoRoomRankingSnapshot.count({ where }),
    ]);
  }

  /** One entity's positions over time — the "my ranking history" read. */
  findTargetHistory(
    targetId: string,
    dimension: string,
    period: string,
    take: number,
  ): Promise<VideoRoomRankingSnapshot[]> {
    return this.prisma.videoRoomRankingSnapshot.findMany({
      where: { targetId, dimension, period },
      orderBy: { dateKey: 'desc' },
      take,
    });
  }

  async pruneSnapshots(period: string, olderThan: Date): Promise<number> {
    const { count } = await this.prisma.videoRoomRankingSnapshot.deleteMany({
      where: { period, createdAt: { lt: olderThan } },
    });
    return count;
  }

  // ================= leaderboard snapshots =================

  /** Upsert, not create: a re-run must overwrite its own ladder, not collide. */
  async upsertLeaderboardSnapshot(input: LeaderboardSnapshotInput): Promise<void> {
    const { scope, dimension, period, dateKey, entries, totalEntries } = input;
    await this.prisma.videoRoomLeaderboardSnapshot.upsert({
      where: { scope_dimension_period_dateKey: { scope, dimension, period, dateKey } },
      create: { scope, dimension, period, dateKey, entries, totalEntries },
      update: { entries, totalEntries, capturedAt: new Date() },
    });
  }

  findLeaderboardSnapshot(
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
  ): Promise<VideoRoomLeaderboardSnapshot | null> {
    return this.prisma.videoRoomLeaderboardSnapshot.findUnique({
      where: { scope_dimension_period_dateKey: { scope, dimension, period, dateKey } },
    });
  }

  // ================= aggregation log (idempotency) =================

  /**
   * Claim a window for recompute.
   *
   * Only a SUCCEEDED row blocks a re-run. FAILED is obviously retryable; so is
   * RUNNING, because a RUNNING row with no `finishedAt` is indistinguishable
   * from a worker that was killed mid-job — and refusing those would leave a
   * window permanently un-aggregated with no operator signal. The fleet-wide
   * lock the job takes before calling this is what prevents two LIVE workers
   * from overlapping; this guard is about redelivery, not concurrency.
   */
  async beginAggregation(
    key: RankingLadderKey,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<'CLAIMED' | 'ALREADY_SUCCEEDED'> {
    const where = { scope_dimension_period_dateKey: { ...key } };
    const existing = await this.prisma.videoRoomRankingAggregationLog.findUnique({ where });
    if (existing?.status === 'SUCCEEDED') return 'ALREADY_SUCCEEDED';

    await this.prisma.videoRoomRankingAggregationLog.upsert({
      where,
      create: { ...key, status: 'RUNNING', windowStart, windowEnd },
      update: {
        status: 'RUNNING',
        windowStart,
        windowEnd,
        startedAt: new Date(),
        finishedAt: null,
        error: null,
      },
    });
    return 'CLAIMED';
  }

  async completeAggregation(key: RankingLadderKey, stats: AggregationStats): Promise<void> {
    await this.prisma.videoRoomRankingAggregationLog.update({
      where: { scope_dimension_period_dateKey: { ...key } },
      data: { status: 'SUCCEEDED', ...stats, finishedAt: new Date(), error: null },
    });
  }

  async failAggregation(key: RankingLadderKey, error: string): Promise<void> {
    await this.prisma.videoRoomRankingAggregationLog.update({
      where: { scope_dimension_period_dateKey: { ...key } },
      data: { status: 'FAILED', error: error.slice(0, 1000), finishedAt: new Date() },
    });
  }

  /**
   * Clear a SUCCEEDED guard so a window can be recomputed again — the
   * recovery tool's primitive, not the aggregation job's.
   *
   * Deliberately `updateMany`, not `update`: a recovery replay is precisely
   * the case where no log row may exist yet for a given dimension (an
   * operator backfilling a window the scheduler never touched), and
   * `update` throws `P2025` when its `where` matches nothing. `updateMany`
   * instead resolves `{ count: 0 }` — exactly the "nothing to invalidate,
   * and that's fine" semantic this needs. Do not swap this back to `update`;
   * see `VideoRoomRankingRecoveryService.replay` for why that matters.
   */
  async invalidateAggregation(key: RankingLadderKey, reason: string): Promise<number> {
    const { count } = await this.prisma.videoRoomRankingAggregationLog.updateMany({
      where: { ...key },
      data: { status: 'FAILED', error: reason.slice(0, 1000), finishedAt: new Date() },
    });
    return count;
  }

  // ================= source aggregates (read-only, other domains) =================

  private giftWhere(window: AggregationWindow, roomId?: string): Prisma.GiftTransactionWhereInput {
    return {
      contextType: GiftContextType.VIDEO_ROOM,
      status: GiftTxnStatus.COMPLETED,
      createdAt: { gte: window.start, lt: window.end },
      ...(roomId ? { contextId: roomId } : {}),
    };
  }

  async aggregateGiftCoinsBySender(
    window: AggregationWindow,
    roomId?: string,
  ): Promise<{ userId: string; coins: bigint; gifts: number }[]> {
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['senderId'],
      where: this.giftWhere(window, roomId),
      _sum: { totalCoinValue: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      userId: r.senderId,
      coins: r._sum.totalCoinValue ?? 0n,
      gifts: r._sum.totalCoinValue === null ? 0 : r._count._all,
    }));
  }

  async aggregateGiftCoinsByReceiver(
    window: AggregationWindow,
    roomId?: string,
  ): Promise<{ userId: string; coins: bigint; gifts: number }[]> {
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['receiverId'],
      where: this.giftWhere(window, roomId),
      _sum: { totalCoinValue: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      userId: r.receiverId,
      coins: r._sum.totalCoinValue ?? 0n,
      gifts: r._sum.totalCoinValue === null ? 0 : r._count._all,
    }));
  }

  /** `contextId` IS the room id for VIDEO_ROOM gifts. */
  async aggregateGiftCoinsByRoom(
    window: AggregationWindow,
  ): Promise<{ roomId: string; coins: bigint; gifts: number }[]> {
    const rows = await this.prisma.giftTransaction.groupBy({
      by: ['contextId'],
      where: this.giftWhere(window),
      _sum: { totalCoinValue: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      roomId: r.contextId,
      coins: r._sum.totalCoinValue ?? 0n,
      gifts: r._sum.totalCoinValue === null ? 0 : r._count._all,
    }));
  }

  /**
   * PK outcomes per user for battles COMPLETED in the window. Read as three
   * queries — battles, their participants, then those participants'
   * contributions — because a participant's win or loss is only knowable
   * from its battle's `winningTeamId` (Prisma cannot express that comparison
   * in a groupBy), and because `score` and `giftCoins` are DIFFERENT
   * quantities that must NOT be conflated:
   *
   * - `score` comes straight from `VideoRoomPkParticipant.score`, which is
   *   `baseAmount × multiplierBps / 10000` — MULTIPLIER-INFLATED above the
   *   true coin value whenever a VIP sender tier or an active event bonus
   *   applies (see `VideoRoomPkScoringService.apply`).
   * - `giftCoins` is the RAW, pre-multiplier coin total: summed from
   *   `VideoRoomPkContribution.baseAmount` for the same battles, grouped by
   *   `participantId` and attributed to that participant's user. A
   *   participant with no contributions gets `giftCoins: 0n`.
   *
   * These are sourced from different tables ON PURPOSE —
   * `VideoRoomRankingScoreEngine` weights `score` and `giftCoins` as
   * SEPARATE composite inputs (`weights.pk = { win, loss, score: 1,
   * giftCoins: 0.5 }`). Setting `giftCoins = score` would double-count the
   * same underlying activity and inflate the whole PK dimension by a
   * multiplier-dependent amount. Do not "simplify" these back to one source.
   */
  async aggregatePkOutcomes(
    window: AggregationWindow,
  ): Promise<{ userId: string; wins: number; losses: number; score: bigint; giftCoins: bigint }[]> {
    const battles = await this.prisma.videoRoomPkBattle.findMany({
      where: {
        status: VideoRoomPkStatus.COMPLETED,
        completedAt: { gte: window.start, lt: window.end },
      },
      select: { id: true, winningTeamId: true, isDraw: true },
    });
    if (battles.length === 0) return [];

    const battleIds = battles.map((b) => b.id);
    const winnerByBattle = new Map(battles.map((b) => [b.id, b.isDraw ? null : b.winningTeamId]));
    const participants = await this.prisma.videoRoomPkParticipant.findMany({
      where: { battleId: { in: battleIds } },
      select: { id: true, battleId: true, userId: true, teamId: true, score: true },
    });

    const userByParticipantId = new Map(participants.map((p) => [p.id, p.userId]));
    const contributions = await this.prisma.videoRoomPkContribution.groupBy({
      by: ['participantId'],
      where: { battleId: { in: battleIds } },
      _sum: { baseAmount: true },
    });
    const coinsByUser = new Map<string, bigint>();
    for (const c of contributions) {
      const userId = userByParticipantId.get(c.participantId);
      if (!userId) continue; // defensive: contribution outliving its participant should not happen
      const base = c._sum.baseAmount ?? 0n;
      coinsByUser.set(userId, (coinsByUser.get(userId) ?? 0n) + base);
    }

    const byUser = new Map<
      string,
      { userId: string; wins: number; losses: number; score: bigint; giftCoins: bigint }
    >();
    for (const p of participants) {
      const entry = byUser.get(p.userId) ?? {
        userId: p.userId,
        wins: 0,
        losses: 0,
        score: 0n,
        giftCoins: 0n,
      };
      const winningTeamId = winnerByBattle.get(p.battleId);
      // A draw counts as neither a win nor a loss — winningTeamId is null.
      if (winningTeamId !== null && winningTeamId !== undefined) {
        if (winningTeamId === p.teamId) entry.wins += 1;
        else entry.losses += 1;
      }
      entry.score += p.score;
      byUser.set(p.userId, entry);
    }
    for (const [userId, coins] of coinsByUser) {
      const entry = byUser.get(userId);
      if (entry) entry.giftCoins = coins;
    }
    return [...byUser.values()];
  }

  async aggregateTreasureWinnings(
    window: AggregationWindow,
  ): Promise<{ userId: string; coins: bigint; events: number }[]> {
    const rows = await this.prisma.treasureWinner.groupBy({
      by: ['userId'],
      where: { selectedAt: { gte: window.start, lt: window.end } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      userId: r.userId,
      coins: r._sum.amount ?? 0n,
      events: r._count._all,
    }));
  }

  findRoomStatistics(
    roomIds: string[],
  ): Promise<
    { roomId: string; peakViewers: number; avgWatchTimeSeconds: number; totalPkCount: number }[]
  > {
    if (roomIds.length === 0) return Promise.resolve([]);
    return this.prisma.videoRoomStatistics.findMany({
      where: { roomId: { in: roomIds } },
      select: {
        roomId: true,
        peakViewers: true,
        avgWatchTimeSeconds: true,
        totalPkCount: true,
      },
    });
  }
}
