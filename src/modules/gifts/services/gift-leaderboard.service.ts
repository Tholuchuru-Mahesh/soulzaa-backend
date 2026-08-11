import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  GIFT_LEADERBOARD_DEFAULT_LIMIT,
  LeaderboardBoard,
  LeaderboardPeriod,
  LeaderboardScope,
} from '../constants/gifts.constants';
import { GiftRepository } from '../repositories/gift.repository';

/** A resolved leaderboard row (rank + user identity + score). */
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string | null;
  score: number;
}

/**
 * Top-gifter / top-receiver leaderboards backed by Redis ZSETs (PRD rankings:
 * daily / weekly / monthly / all-time, room-scoped and global). On every gift
 * the sender's spend and the receiver's earnings are added to all period + scope
 * boards in real time; reads resolve the top N and hydrate usernames. Persistent
 * ranking snapshots are a later phase — this owns the live view.
 */
@Injectable()
export class GiftLeaderboardService {
  private readonly retentionSeconds: number;

  constructor(
    private readonly repo: GiftRepository,
    config: ConfigService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
  ) {
    const cfg = config.get('gift') as { leaderboardRetentionDays: number };
    this.retentionSeconds = cfg.leaderboardRetentionDays * 86_400;
  }

  /** Record a completed gift against every gifter + receiver board. */
  async record(input: {
    contextId: string;
    senderId: string;
    receiverId: string;
    giftValue: number;
    receiverEarnings: number;
  }): Promise<void> {
    const now = new Date();
    const scopes: Array<{ scope: LeaderboardScope; scopeId: string | null }> = [
      { scope: LeaderboardScope.GLOBAL, scopeId: null },
      { scope: LeaderboardScope.ROOM, scopeId: input.contextId },
    ];

    const writes: Array<Promise<void>> = [];
    for (const period of Object.values(LeaderboardPeriod)) {
      const bucket = this.bucket(period, now);
      // ALL_TIME never expires; time-bucketed boards use the retention TTL.
      const ttl = period === LeaderboardPeriod.ALL_TIME ? 0 : this.retentionSeconds;
      for (const { scope, scopeId } of scopes) {
        writes.push(
          this.repo.addLeaderboardScore(
            LeaderboardBoard.GIFTER,
            scope,
            scopeId,
            bucket,
            input.senderId,
            input.giftValue,
            ttl,
          ),
        );
        writes.push(
          this.repo.addLeaderboardScore(
            LeaderboardBoard.RECEIVER,
            scope,
            scopeId,
            bucket,
            input.receiverId,
            input.receiverEarnings,
            ttl,
          ),
        );
      }
      // FANS: cross-room by definition — this sender's gross gift value credited
      // to this one receiver's own fan board (Creator Center — Top Fans). Gross
      // coin value, per the "total gift coins sent to the creator" ranking rule.
      writes.push(
        this.repo.addLeaderboardScore(
          LeaderboardBoard.FANS,
          LeaderboardScope.CREATOR,
          input.receiverId,
          bucket,
          input.senderId,
          input.giftValue,
          ttl,
        ),
      );
    }
    await Promise.all(writes);
  }

  /** Read the current top N of a board for a period + scope. */
  async top(input: {
    board: LeaderboardBoard;
    scope: LeaderboardScope;
    contextId?: string;
    period: LeaderboardPeriod;
    limit?: number;
  }): Promise<LeaderboardEntry[]> {
    const bucket = this.bucket(input.period, new Date());
    const scopeId = input.scope === LeaderboardScope.ROOM ? (input.contextId ?? null) : null;
    const rows = await this.repo.topLeaderboard(
      input.board,
      input.scope,
      scopeId,
      bucket,
      input.limit ?? GIFT_LEADERBOARD_DEFAULT_LIMIT,
    );
    const users = await Promise.all(rows.map((r) => this.users.findById(r.userId)));
    return rows.map((r, i) => ({
      rank: r.rank,
      userId: r.userId,
      username: users[i]?.username ?? null,
      score: r.score,
    }));
  }

  /** Creator Center — Top Fans: who has given this creator the most, ranked. */
  async topFans(
    creatorId: string,
    period: LeaderboardPeriod,
    limit: number,
  ): Promise<{ userId: string; totalCoins: number; rank: number }[]> {
    const bucket = this.bucket(period, new Date());
    const rows = await this.repo.topLeaderboard(
      LeaderboardBoard.FANS,
      LeaderboardScope.CREATOR,
      creatorId,
      bucket,
      limit,
    );
    return rows.map((r) => ({ userId: r.userId, totalCoins: r.score, rank: r.rank }));
  }

  /** Start of the current period window (UTC); null = all-time. Used to hydrate
   *  count/lastGiftAt from Postgres consistently with the ZSET's own bucket. */
  periodStart(period: LeaderboardPeriod, now = new Date()): Date | null {
    switch (period) {
      case LeaderboardPeriod.DAILY:
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      case LeaderboardPeriod.WEEKLY: {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
        d.setUTCDate(d.getUTCDate() - dayNum + 1);
        return d;
      }
      case LeaderboardPeriod.MONTHLY:
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      case LeaderboardPeriod.ALL_TIME:
      default:
        return null;
    }
  }

  // ---- Period bucketing ----

  private bucket(period: LeaderboardPeriod, now: Date): string {
    switch (period) {
      case LeaderboardPeriod.DAILY:
        return this.isoDate(now);
      case LeaderboardPeriod.WEEKLY:
        return this.isoWeek(now);
      case LeaderboardPeriod.MONTHLY:
        return `${now.getUTCFullYear()}-${this.pad(now.getUTCMonth() + 1)}`;
      case LeaderboardPeriod.ALL_TIME:
      default:
        return 'all';
    }
  }

  private isoDate(d: Date): string {
    return `${d.getUTCFullYear()}-${this.pad(d.getUTCMonth() + 1)}-${this.pad(d.getUTCDate())}`;
  }

  /** ISO-8601 year-week bucket, e.g. `2026-W28`. */
  private isoWeek(date: Date): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${this.pad(week)}`;
  }

  private pad(n: number): string {
    return String(n).padStart(2, '0');
  }
}
