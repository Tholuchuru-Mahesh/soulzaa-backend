import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RedisService } from 'src/infra/redis/redis.service';
import {
  SCORE_WINDOW_DAYS,
  gradeFor,
  scoreMember,
  topPercentFor,
  type ScoreInputs,
} from '../constants/member-score.constants';
import type { MemberScore } from '../interfaces/agency-member.interface';
import { AgencyCommunityService } from './agency-community.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_SECONDS = 300;

/**
 * Scores and ranks an agency's members on engagement.
 *
 * Ranking is whole-agency by nature — one member's position cannot be known
 * without scoring everyone else — so this deliberately computes the entire
 * agency at once and caches the result, rather than offering a cheap-looking
 * per-member call that would quietly do the same work on every profile open.
 */
@Injectable()
export class AgencyMemberScoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly community: AgencyCommunityService,
  ) {}

  /** Every active member of [agencyId], scored and ranked, keyed by user id. */
  async rankAgency(agencyId: string): Promise<Map<string, MemberScore>> {
    const cached = await this.readCache(agencyId);
    if (cached) return cached;

    const memberIds = await this.community.getActiveHostIds(agencyId);
    if (memberIds.length === 0) return new Map();

    const to = new Date();
    const from = new Date(to.getTime() - SCORE_WINDOW_DAYS * DAY_MS);
    const inputs = await this.scoreInputsFor(memberIds, from, to);
    const ranked = this.rank(memberIds, inputs);

    await this.writeCache(agencyId, ranked);
    return ranked;
  }

  /**
   * The raw score inputs for [userIds] over `[from, to)`.
   *
   * Five queries total, never one per member: the whole set is fetched and
   * bucketed in memory, the same way `AgencyCommunityService.getGrowth` avoids
   * one COUNT per day. A 7,000-member agency costs the same five round-trips
   * as a 7-member one.
   */
  async scoreInputsFor(userIds: string[], from: Date, to: Date): Promise<Map<string, ScoreInputs>> {
    const result = new Map<string, ScoreInputs>(userIds.map((id) => [id, this.emptyInputs()]));
    if (userIds.length === 0) return result;

    const window = { gte: from, lt: to };
    const [logins, audioJoins, videoJoins, sent, received] = await Promise.all([
      this.prisma.sessionHistory.findMany({
        where: { userId: { in: userIds }, event: 'CREATED', createdAt: window },
        select: { userId: true, createdAt: true },
      }),
      this.prisma.roomMember.findMany({
        where: { userId: { in: userIds }, joinedAt: window },
        select: { userId: true },
      }),
      this.prisma.videoRoomMember.findMany({
        where: { userId: { in: userIds }, joinedAt: window },
        select: { userId: true },
      }),
      this.prisma.giftTransaction.groupBy({
        by: ['senderId'],
        where: { senderId: { in: userIds }, createdAt: window },
        _count: true,
      }),
      this.prisma.giftTransaction.groupBy({
        by: ['receiverId'],
        where: { receiverId: { in: userIds }, createdAt: window },
        _count: true,
      }),
    ]);

    // Distinct calendar days, not login events: signing in three times before
    // lunch is one active day, and counting it as three would let a single
    // restless afternoon outscore a month of steady use.
    const loginDaysByUser = new Map<string, Set<string>>();
    for (const row of logins) {
      const days = loginDaysByUser.get(row.userId) ?? new Set<string>();
      days.add(row.createdAt.toISOString().slice(0, 10));
      loginDaysByUser.set(row.userId, days);
    }
    for (const [userId, days] of loginDaysByUser) {
      const entry = result.get(userId);
      if (entry) entry.loginDays = days.size;
    }

    for (const row of [...audioJoins, ...videoJoins]) {
      const entry = result.get(row.userId);
      if (entry) entry.roomsJoined += 1;
    }

    for (const row of sent) {
      const entry = result.get(row.senderId);
      if (entry) entry.giftsSent = this.countOf(row);
    }
    for (const row of received) {
      const entry = result.get(row.receiverId);
      if (entry) entry.giftsReceived = this.countOf(row);
    }

    return result;
  }

  private emptyInputs(): ScoreInputs {
    return { loginDays: 0, roomsJoined: 0, giftsSent: 0, giftsReceived: 0 };
  }

  /**
   * Prisma types `_count` as a number for a bare `_count: true`, but as an
   * object when fields are named. Both are read so a later query change cannot
   * silently zero every gift figure.
   */
  private countOf(row: { _count?: unknown }): number {
    const count = row._count;
    if (typeof count === 'number') return count;
    if (count && typeof count === 'object' && '_all' in count) {
      return Number((count as { _all: number })._all) || 0;
    }
    return 0;
  }

  private rank(memberIds: string[], inputs: Map<string, ScoreInputs>): Map<string, MemberScore> {
    const withScores = memberIds.map((userId) => {
      const memberInputs = inputs.get(userId) ?? this.emptyInputs();
      return { userId, inputs: memberInputs, score: scoreMember(memberInputs) };
    });

    // Ties break on user id so the ordering is total and stable. Without this,
    // two members on the same score could swap positions between two loads of
    // the same screen.
    withScores.sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));

    const totalMembers = withScores.length;
    return new Map(
      withScores.map((row, index) => {
        const rank = index + 1;
        return [
          row.userId,
          {
            userId: row.userId,
            score: row.score,
            rank,
            totalMembers,
            topPercent: topPercentFor(rank, totalMembers),
            grade: gradeFor(row.score),
            inputs: row.inputs,
          },
        ];
      }),
    );
  }

  private cacheKey(agencyId: string): string {
    return `agency:member-rank:${agencyId}`;
  }

  private async readCache(agencyId: string): Promise<Map<string, MemberScore> | null> {
    try {
      const raw = await this.redis.client.get(this.cacheKey(agencyId));
      if (!raw) return null;
      return new Map(JSON.parse(raw) as [string, MemberScore][]);
    } catch {
      // A cache that cannot be read is a slow request, not a failed one.
      return null;
    }
  }

  private async writeCache(agencyId: string, ranked: Map<string, MemberScore>): Promise<void> {
    try {
      await this.redis.client.set(
        this.cacheKey(agencyId),
        JSON.stringify([...ranked.entries()]),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch {
      // Same reasoning: failing to cache must not fail the request.
    }
  }
}
