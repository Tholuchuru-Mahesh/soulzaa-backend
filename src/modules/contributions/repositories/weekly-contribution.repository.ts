import { Injectable } from '@nestjs/common';
import { GiftContextType, GiftTxnStatus, Prisma } from '@prisma/client';
import {
  currentIsoWeekKeyUtc,
  isoWeekKeyRange,
  isoWeekWindowUtc,
} from 'src/common/utils/iso-week.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { ContributionScope } from '../dto/contributions.dto';

export interface WeekBucket {
  weekKey: string;
  weekStart: string;
  weekEnd: string;
  amount: number;
}

export interface MonthBucket {
  monthKey: string; // "2026-01"
  amount: number;
}

export interface LeaderboardRow {
  id: string; // roomId or userId
  amount: number;
}

/** Room contexts whose gifts feed the room-contribution counters. */
const ROOM_CONTEXTS: GiftContextType[] = [GiftContextType.AUDIO_ROOM, GiftContextType.VIDEO_ROOM];

/**
 * Reads for the weekly-contribution feature. The per-week rows
 * (`RoomWeeklyContribution` / `UserWeeklyContribution`) are the fast path; the
 * immutable `GiftTransaction` ledger is the source of truth used for backfill,
 * month rollups, and reconciling any week whose bucket predates the feature.
 */
@Injectable()
export class WeeklyContributionRepository {
  constructor(private readonly prisma: PrismaService) {}

  currentWeekKey(): string {
    return currentIsoWeekKeyUtc();
  }

  // ---- Fast path: the per-week buckets ----

  async getWeekBucket(scope: ContributionScope, id: string, weekKey: string): Promise<WeekBucket> {
    const { start, end } = isoWeekWindowUtc(weekKey);
    const row =
      scope === 'room'
        ? await this.prisma.roomWeeklyContribution.findUnique({
            where: { roomId_weekKey: { roomId: id, weekKey } },
          })
        : await this.prisma.userWeeklyContribution.findUnique({
            where: { userId_weekKey: { userId: id, weekKey } },
          });

    if (row) {
      return {
        weekKey,
        weekStart: row.weekStart.toISOString(),
        weekEnd: row.weekEnd.toISOString(),
        amount: Number(row.amount),
      };
    }
    // No bucket yet — derive from the ledger so history is never blank.
    const amount = await this.ledgerSum(scope, id, start, end);
    return {
      weekKey,
      weekStart: start.toISOString(),
      weekEnd: end.toISOString(),
      amount,
    };
  }

  async listWeekBuckets(
    scope: ContributionScope,
    id: string,
    fromKey: string,
    toKey: string,
  ): Promise<WeekBucket[]> {
    const keys = isoWeekKeyRange(fromKey, toKey);
    if (keys.length === 0) return [];

    const rows =
      scope === 'room'
        ? await this.prisma.roomWeeklyContribution.findMany({
            where: { roomId: id, weekKey: { in: keys } },
          })
        : await this.prisma.userWeeklyContribution.findMany({
            where: { userId: id, weekKey: { in: keys } },
          });
    const byKey = new Map(rows.map((r) => [r.weekKey, r]));

    // Any missing week is reconstructed from the ledger (covers pre-backfill).
    const out: WeekBucket[] = [];
    for (const weekKey of keys) {
      const { start, end } = isoWeekWindowUtc(weekKey);
      const row = byKey.get(weekKey);
      out.push({
        weekKey,
        weekStart: start.toISOString(),
        weekEnd: end.toISOString(),
        amount: row ? Number(row.amount) : await this.ledgerSum(scope, id, start, end),
      });
    }
    return out;
  }

  async weekLeaderboard(
    scope: ContributionScope,
    weekKey: string,
    limit: number,
  ): Promise<LeaderboardRow[]> {
    if (scope === 'room') {
      const rows = await this.prisma.roomWeeklyContribution.findMany({
        where: { weekKey },
        orderBy: { amount: 'desc' },
        take: limit,
      });
      return rows.map((r) => ({ id: r.roomId, amount: Number(r.amount) }));
    }
    const rows = await this.prisma.userWeeklyContribution.findMany({
      where: { weekKey },
      orderBy: { amount: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({ id: r.userId, amount: Number(r.amount) }));
  }

  // ---- Source of truth: the gift ledger ----

  /** Σ gift coin value for a room / user (received) in `[start, end)`. */
  async ledgerSum(scope: ContributionScope, id: string, start: Date, end: Date): Promise<number> {
    const where: Prisma.GiftTransactionWhereInput = {
      status: GiftTxnStatus.COMPLETED,
      contextType: { in: ROOM_CONTEXTS },
      createdAt: { gte: start, lt: end },
      ...(scope === 'room' ? { contextId: id } : { receiverId: id }),
    };
    const agg = await this.prisma.giftTransaction.aggregate({
      where,
      _sum: { totalCoinValue: true },
    });
    return Number(agg._sum.totalCoinValue ?? 0n);
  }

  /** Calendar-month rollup straight from the ledger (months ≠ Σ ISO weeks). */
  async monthHistory(
    scope: ContributionScope,
    id: string,
    from: Date,
    to: Date,
  ): Promise<MonthBucket[]> {
    const col = scope === 'room' ? Prisma.sql`"contextId"` : Prisma.sql`"receiverId"`;
    const rows = await this.prisma.$queryRaw<{ month: Date; amount: bigint | null }[]>`
      SELECT date_trunc('month', "createdAt") AS month,
             SUM("totalCoinValue")            AS amount
      FROM gift_transactions
      WHERE status = 'COMPLETED'
        AND "contextType" IN ('AUDIO_ROOM', 'VIDEO_ROOM')
        AND ${col} = ${id}::uuid
        AND "createdAt" >= ${from}
        AND "createdAt" < ${to}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    return rows.map((r) => ({
      monthKey: r.month.toISOString().slice(0, 7),
      amount: Number(r.amount ?? 0n),
    }));
  }

  /** Earliest gift instant for a room / user (for a default "from" bound). */
  async firstGiftAt(scope: ContributionScope, id: string): Promise<Date | null> {
    const row = await this.prisma.giftTransaction.findFirst({
      where: {
        status: GiftTxnStatus.COMPLETED,
        contextType: { in: ROOM_CONTEXTS },
        ...(scope === 'room' ? { contextId: id } : { receiverId: id }),
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  /** Lifetime room contribution (legacy counter) — for the rollover payload. */
  async roomLifetimeContribution(roomId: string): Promise<number> {
    const row = await this.prisma.roomContributionCounter.findUnique({ where: { roomId } });
    return Number(row?.amount ?? 0n);
  }

  /** Room ids that are currently LIVE (for the weekly-rollover broadcast). */
  async liveRoomIds(): Promise<string[]> {
    const [audio, video] = await Promise.all([
      this.prisma.audioRoom.findMany({ where: { status: 'LIVE' }, select: { id: true } }),
      this.prisma.videoRoom.findMany({ where: { status: 'LIVE' }, select: { id: true } }),
    ]);
    return [...audio.map((r) => r.id), ...video.map((r) => r.id)];
  }
}
