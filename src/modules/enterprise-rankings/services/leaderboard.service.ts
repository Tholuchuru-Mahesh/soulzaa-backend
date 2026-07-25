import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LeaderboardStore } from 'src/modules/rankings/services/leaderboard-store.service';
import { RankingValidationService } from './ranking-validation.service';

export interface HydratedLeaderboardEntry {
  rank: number;
  previousRank: number | null;
  rankDelta: number;
  entityId: string;
  entityType: string;
  score: number;
  entityDetails?: {
    name?: string;
    username?: string;
    avatarKey?: string;
    level?: number;
    vipLevel?: number;
  };
}

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: LeaderboardStore,
    private readonly validationService: RankingValidationService,
  ) {}

  /**
   * Retrieves a paginated leaderboard for a given ranking definition.
   */
  async getLeaderboard(
    rankingId: string,
    dateKey?: string,
    limit = 50,
    offset = 0,
  ): Promise<{ items: HydratedLeaderboardEntry[]; total: number; limit: number; offset: number }> {
    const def = await this.validationService.validateRankingDefinitionExists(rankingId);
    const key = dateKey ?? this.buildCurrentDateKey(def.timeWindow);

    const [entries, total] = await Promise.all([
      this.prisma.rankingEntry.findMany({
        where: { rankingId, dateKey: key },
        orderBy: { rank: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.rankingEntry.count({ where: { rankingId, dateKey: key } }),
    ]);

    if (entries.length === 0) {
      return { items: [], total: 0, limit, offset };
    }

    const entityIds = entries.map((e) => e.entityId);
    const detailsMap = await this.hydrateEntities(def.entityType, entityIds);

    const items: HydratedLeaderboardEntry[] = entries.map((e) => ({
      rank: e.rank,
      previousRank: e.previousRank,
      rankDelta: e.rankDelta,
      entityId: e.entityId,
      entityType: e.entityType,
      score: Number(e.score),
      entityDetails: detailsMap.get(e.entityId),
    }));

    return { items, total, limit, offset };
  }

  /**
   * Reads real-time top leaderboard directly from Redis (if configured for Redis sync).
   */
  async getRedisTopLeaderboard(
    key: string,
    limit = 50,
  ): Promise<{ member: string; score: number }[]> {
    const raw = await this.store.top(key, limit);
    return raw.map((e) => ({ member: e.member, score: e.score }));
  }

  private async hydrateEntities(
    entityType: string,
    entityIds: string[],
  ): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    if (entityIds.length === 0) return map;

    if (entityType === 'USER') {
      const [users, profiles, stats] = await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: entityIds } },
          select: { id: true, username: true, fullName: true },
        }),
        this.prisma.userProfile.findMany({
          where: { userId: { in: entityIds } },
          select: { userId: true, avatarKey: true },
        }),
        this.prisma.userStatistics.findMany({
          where: { userId: { in: entityIds } },
          select: { userId: true, level: true, vipLevel: true },
        }),
      ]);

      for (const u of users) {
        const prof = profiles.find((p) => p.userId === u.id);
        const stat = stats.find((s) => s.userId === u.id);
        map.set(u.id, {
          username: u.username,
          name: u.fullName ?? u.username,
          avatarKey: prof?.avatarKey ?? null,
          level: stat?.level ?? 1,
          vipLevel: stat?.vipLevel ?? 0,
        });
      }
    } else if (entityType === 'FAMILY') {
      const families = await this.prisma.family.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, name: true, logo: true, level: true },
      });
      for (const f of families) {
        map.set(f.id, { name: f.name, avatarKey: f.logo, level: f.level });
      }
    }

    return map;
  }

  private buildCurrentDateKey(timeWindow: string): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');

    switch (timeWindow) {
      case 'HOURLY':
        return `${y}${m}${d}${String(now.getUTCHours()).padStart(2, '0')}`;
      case 'DAILY':
        return `${y}${m}${d}`;
      case 'MONTHLY':
        return `${y}${m}`;
      case 'YEARLY':
        return `${y}`;
      default:
        return 'alltime';
    }
  }
}
