import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LeaderboardStore, RankingPeriodResolver } from 'src/modules/rankings/interfaces';
import { SOCIAL_SERVICE, type ISocialService } from 'src/modules/social/interfaces';
import {
  VIDEO_ROOM_RANKING_MAX_PAGE_SIZE,
  VIDEO_ROOM_RANKING_NAMESPACE,
  scopeGlobal,
} from '../constants/video-room-ranking.constants';
import { LeaderboardException } from '../exceptions/video-room-ranking.exceptions';
import { VideoRoomRankingRepository } from '../repositories/video-room-ranking.repository';
import type {
  RankingEntryDto,
  RankingQuery,
  RankingViewer,
} from './video-room-ranking-query.service';

export type RankingAudience = 'friends' | 'following';

/**
 * Friends and Following leaderboards.
 *
 * These are PROJECTIONS, not ladders. The audience id set is fetched from the
 * social graph and scored against an existing ladder with one ZMSCORE — so a
 * friends leaderboard costs nothing on the write path, can never drift from the
 * global ladder it derives from, and needs no keys of its own. Maintaining a
 * per-user friends ZSET would mean fanning every gift out across the sender's
 * entire friend list, which is unbounded work per gift.
 */
@Injectable()
export class VideoRoomLeaderboardService {
  private readonly ns = VIDEO_ROOM_RANKING_NAMESPACE;

  constructor(
    private readonly store: LeaderboardStore,
    private readonly periods: RankingPeriodResolver,
    @Inject(SOCIAL_SERVICE) private readonly social: ISocialService,
    private readonly repo: VideoRoomRankingRepository,
  ) {}

  async projectAudience(
    viewer: RankingViewer,
    query: RankingQuery,
    audience: RankingAudience,
  ): Promise<Paginated<RankingEntryDto>> {
    if (viewer.isGuest) {
      throw new LeaderboardException(
        'guests have no social graph to project a leaderboard onto',
        HttpStatus.FORBIDDEN,
      );
    }

    // Same ceiling as the sibling `getLadder` read path, applied here for
    // consistency and defense-in-depth: this is a projection, not a ladder
    // read, but an unclamped `limit` would still let a caller demand an
    // unbounded ZMSCORE fan-out and hydration.
    const limit = Math.min(Math.max(1, Math.floor(query.limit)), VIDEO_ROOM_RANKING_MAX_PAGE_SIZE);
    const page = Math.max(1, Math.floor(query.page));

    const memberIds =
      audience === 'friends'
        ? await this.social.friendIds(viewer.id)
        : await this.social.followerIds(viewer.id);

    if (memberIds.length === 0) {
      return buildPaginated([], 0, page, limit);
    }

    const dateKey = query.dateKey ?? this.periods.dateKeyFor(query.period, new Date());
    const key = this.store.key(
      this.ns,
      query.scope ?? scopeGlobal(),
      query.dimension,
      query.period,
      dateKey,
    );

    const scores = await this.store.scoreMany(key, memberIds);

    // An unscored member is absent from the ladder, not tied at zero — ranking
    // them would put everyone who did nothing above everyone not yet loaded.
    const ranked = memberIds
      .map((id, i) => ({ member: id, score: scores[i] }))
      .filter((e): e is { member: string; score: number } => e.score !== null)
      .sort((a, b) => b.score - a.score);

    const total = ranked.length;
    const start = (page - 1) * limit;
    const pageSlice = ranked.slice(start, start + limit);

    const details = await this.repo.hydrateTargets(
      pageSlice.map((e) => e.member),
      'user',
    );
    const byId = new Map(details.map((d) => [d.id, d]));

    const items: RankingEntryDto[] = pageSlice.map((entry, index) => {
      const detail = byId.get(entry.member);
      return {
        rank: start + index + 1,
        targetId: entry.member,
        username: detail?.username ?? 'Unknown',
        avatarKey: detail?.avatarKey ?? null,
        score: entry.score,
        level: detail?.level ?? 1,
        vipLevel: detail?.vipLevel ?? 0,
      };
    });

    return buildPaginated(items, total, page, limit);
  }
}
