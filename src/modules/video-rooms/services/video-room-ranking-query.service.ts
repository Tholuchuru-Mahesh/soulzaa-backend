import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  LeaderboardCache,
  LeaderboardStore,
  RankingPeriodResolver,
  type RankedEntry,
  type RankingPeriodName,
} from 'src/modules/rankings/interfaces';
import {
  loadVideoRoomRankingConfig,
  type VideoRoomRankingConfig,
} from '../config/video-room-ranking.config';
import {
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_GUEST_LIMIT,
  VIDEO_ROOM_RANKING_MAX_PAGE_SIZE,
  VIDEO_ROOM_RANKING_NAMESPACE,
  errorMessage,
  isRankingDimension,
  scopeGlobal,
} from '../constants/video-room-ranking.constants';
import {
  RankingException,
  RankingPeriodException,
} from '../exceptions/video-room-ranking.exceptions';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/** The minimum a read path needs to know about who is asking. */
export interface RankingViewer {
  id: string;
  isGuest: boolean;
}

export interface RankingQuery {
  dimension: VideoRoomRankingDimension;
  period: RankingPeriodName;
  /** Omitted means "the current window". */
  dateKey?: string;
  /** Omitted means global. */
  scope?: string;
  limit: number;
  page: number;
}

export interface RankingEntryDto {
  rank: number;
  targetId: string;
  username: string;
  avatarKey: string | null;
  score: number;
  level: number;
  vipLevel: number;
}

export interface SelfRankDto {
  dimension: string;
  period: string;
  dateKey: string;
  /** Null when the viewer has no score on this ladder. */
  rank: number | null;
  score: number;
}

/** Dimensions whose members are rooms rather than users. */
const ROOM_MEMBER_DIMENSIONS = new Set<string>([VideoRoomRankingDimension.ROOMS]);

/**
 * The VR-13 read path.
 *
 * Reads resolve in a strict order of preference: cached hydrated page → live
 * Redis ladder → durable snapshot. The last step is what keeps a leaderboard
 * screen working during a Redis incident — a ladder that is an hour stale is a
 * far better answer than a 500, and this is a read-only, non-financial surface
 * where that trade is clearly correct.
 *
 * Authorization lives here rather than in the controller, matching the
 * VR-10/11/12 convention.
 */
@Injectable()
export class VideoRoomRankingQueryService {
  private readonly logger = new Logger(VideoRoomRankingQueryService.name);
  private readonly config: VideoRoomRankingConfig;
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    config: ConfigService,
    private readonly store: LeaderboardStore,
    private readonly cache: LeaderboardCache,
    private readonly periods: RankingPeriodResolver,
    private readonly repo: VideoRoomRankingRepository,
    private readonly metrics: VideoRoomsMetrics,
  ) {
    this.config = loadVideoRoomRankingConfig(config);
  }

  async getLadder(viewer: RankingViewer, query: RankingQuery): Promise<Paginated<RankingEntryDto>> {
    const startedAt = Date.now();
    try {
      return await this.readLadder(viewer, query);
    } finally {
      // `finally`, so a rejected read still reports its latency. A p99 computed
      // only from successful requests hides exactly the slow failures — a
      // timing-out Redis read — that the panel exists to surface.
      this.metrics.observeRankingApi(query.dimension, (Date.now() - startedAt) / 1000);
    }
  }

  private async readLadder(
    viewer: RankingViewer,
    query: RankingQuery,
  ): Promise<Paginated<RankingEntryDto>> {
    const { dimension, period } = query;

    if (!isRankingDimension(dimension)) {
      throw new RankingException(
        `unknown ranking dimension "${dimension}"`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Defensive floor, independent of the guest checks below and of whatever
    // a controller may already have normalized: this file must be correct
    // standalone. An un-floored page=0/negative page would make `start`
    // negative, and `store.range` (ZREVRANGE under the hood) treats a
    // negative index as an offset from the END — silently handing back the
    // BOTTOM of the ladder instead of erroring or clamping to the top.
    const page = VideoRoomRankingQueryService.toPositiveInt(query.page);
    const rawLimit = VideoRoomRankingQueryService.toPositiveInt(query.limit);

    // Guest gate, applied before anything is read.
    if (viewer.isGuest) {
      if (page > 1) {
        throw new RankingException(
          'guests may read only the first page of a leaderboard',
          HttpStatus.FORBIDDEN,
        );
      }
      if (query.dateKey) {
        throw new RankingException(
          'guests may not read historical leaderboards',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    const dateKey = query.dateKey ?? this.periods.dateKeyFor(period, new Date());
    if (!this.periods.isValidDateKey(period, dateKey)) {
      throw new RankingPeriodException(`"${dateKey}" is not a valid ${period} date key`);
    }

    const scope = query.scope ?? scopeGlobal();
    const limit = viewer.isGuest
      ? Math.min(rawLimit, VIDEO_ROOM_RANKING_GUEST_LIMIT)
      : Math.min(rawLimit, VIDEO_ROOM_RANKING_MAX_PAGE_SIZE);
    const start = (page - 1) * limit;
    const stop = viewer.isGuest
      ? Math.min(start + limit, VIDEO_ROOM_RANKING_GUEST_LIMIT) - 1
      : start + limit - 1;

    // The hydrated page cache's key (see `LeaderboardCache`) carries no
    // `limit` and no guest/audience indicator, so a page written for one
    // effective limit can be read back by a request with a different one.
    // Two fixes for that single root cause:
    //  - Guests never read or write this cache at all. Guests are a small,
    //    top-10-only surface, so recomputing on every request is cheap, and
    //    it makes it structurally impossible for a guest to receive a
    //    member-warmed, larger page via `if (cached) return cached`.
    //  - Members validate the hit: `Paginated.limit` already records the
    //    exact effective limit the cached page was built with, so a hit
    //    whose `limit` doesn't match this request's effective limit is for a
    //    different slice of the same key and must be treated as a miss
    //    rather than silently truncating (or padding) this caller's page.
    let cached: Paginated<RankingEntryDto> | null = null;
    if (!viewer.isGuest) {
      const hit = await this.cache.read<Paginated<RankingEntryDto>>(
        this.ns,
        scope,
        dimension,
        period,
        dateKey,
        page,
      );
      cached = hit && hit.limit === limit ? hit : null;
    }
    if (cached) return cached;

    // A closed window is answered from the durable record, not from a Redis
    // ladder that has since been TTL'd away.
    const current = this.periods.dateKeyFor(period, new Date());
    const isClosed = period !== 'alltime' && dateKey !== current;

    const { entries, total } = isClosed
      ? await this.fromSnapshots(scope, dimension, period, dateKey, start, limit)
      : await this.fromRedis(scope, dimension, period, dateKey, start, stop);

    const items = await this.hydrate(entries, dimension, start);
    const builtPage = buildPaginated(items, total, page, limit);

    if (!viewer.isGuest) {
      await this.cache.write(
        this.ns,
        scope,
        dimension,
        period,
        dateKey,
        page,
        builtPage,
        this.config.cacheTtlSeconds,
      );
    }
    return builtPage;
  }

  /**
   * Floor a page/limit input to a safe positive integer. Anything that isn't
   * a finite number >= 1 (0, negative, NaN, Infinity) collapses to 1 rather
   * than propagating into a Redis index or an unbounded slice.
   */
  private static toPositiveInt(value: number): number {
    const floored = Math.floor(value);
    return Number.isFinite(floored) && floored >= 1 ? floored : 1;
  }

  private async fromRedis(
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    start: number,
    stop: number,
  ): Promise<{ entries: RankedEntry[]; total: number }> {
    const key = this.store.key(this.ns, scope, dimension, period, dateKey);
    try {
      const [entries, total] = await Promise.all([
        this.store.range(key, start, stop),
        this.store.count(key),
      ]);
      return { entries, total };
    } catch (err) {
      // Degrade to the durable copy rather than failing the request. This
      // fallback exists to turn a Redis outage into a stale-but-200 read; it
      // must never itself become the 500 it was written to prevent, so a
      // failure here (Postgres also down, a malformed snapshot payload) is
      // swallowed the same way and degrades one step further, to an empty
      // page.
      this.logger.warn(`redis ladder read failed for ${key}: ${errorMessage(err)}`);
      try {
        const snapshot = await this.repo.findLeaderboardSnapshot(scope, dimension, period, dateKey);
        if (!snapshot) return { entries: [], total: 0 };
        const stored = snapshot.entries as unknown as {
          targetId: string;
          score: string;
        }[];
        return {
          entries: stored.slice(start, stop + 1).map((e) => ({
            member: e.targetId,
            score: Number(e.score),
          })),
          total: snapshot.totalEntries,
        };
      } catch (fallbackErr) {
        this.logger.warn(
          `leaderboard snapshot fallback failed for ${key}: ${errorMessage(fallbackErr)}`,
        );
        return { entries: [], total: 0 };
      }
    }
  }

  private async fromSnapshots(
    scope: string,
    dimension: string,
    period: string,
    dateKey: string,
    skip: number,
    take: number,
  ): Promise<{ entries: RankedEntry[]; total: number }> {
    const [rows, total] = await this.repo.findRankingSnapshots(
      scope,
      dimension,
      period,
      dateKey,
      skip,
      take,
    );
    return {
      entries: rows.map((r) => ({ member: r.targetId, score: Number(r.score) })),
      total,
    };
  }

  private async hydrate(
    entries: RankedEntry[],
    dimension: string,
    start: number,
  ): Promise<RankingEntryDto[]> {
    if (entries.length === 0) return [];
    const kind = ROOM_MEMBER_DIMENSIONS.has(dimension) ? 'room' : 'user';
    const details = await this.repo.hydrateTargets(
      entries.map((e) => e.member),
      kind,
    );
    const byId = new Map(details.map((d) => [d.id, d]));

    return entries.map((entry, index) => {
      const detail = byId.get(entry.member);
      return {
        // `start + index + 1`: ranks continue across pages rather than
        // restarting at 1 on page 2.
        rank: start + index + 1,
        targetId: entry.member,
        username: detail?.username ?? 'Unknown',
        avatarKey: detail?.avatarKey ?? null,
        score: entry.score,
        level: detail?.level ?? 1,
        vipLevel: detail?.vipLevel ?? 0,
      };
    });
  }

  async getSelfRank(
    viewer: RankingViewer,
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    scope: string = scopeGlobal(),
  ): Promise<SelfRankDto> {
    if (viewer.isGuest) {
      throw new RankingException('guests have no ranking position', HttpStatus.FORBIDDEN);
    }
    const dateKey = this.periods.dateKeyFor(period, new Date());
    const key = this.store.key(this.ns, scope, dimension, period, dateKey);
    const [rank, score] = await Promise.all([
      this.store.rank(key, viewer.id),
      this.store.score(key, viewer.id),
    ]);
    return {
      dimension,
      period,
      dateKey,
      // ZREVRANK is 0-based; the API is 1-based. Null stays null — "unranked"
      // is meaningfully different from "rank 1".
      rank: rank === null ? null : rank + 1,
      score: score ?? 0,
    };
  }

  async getHistory(
    viewer: RankingViewer,
    targetId: string,
    dimension: VideoRoomRankingDimension,
    period: RankingPeriodName,
    limit: number,
  ): Promise<{ dateKey: string; rank: number; score: number }[]> {
    if (viewer.isGuest) {
      throw new RankingException('guests may not read ranking history', HttpStatus.FORBIDDEN);
    }
    const rows = await this.repo.findTargetHistory(targetId, dimension, period, limit);
    return rows.map((r) => ({ dateKey: r.dateKey, rank: r.rank, score: Number(r.score) }));
  }
}
