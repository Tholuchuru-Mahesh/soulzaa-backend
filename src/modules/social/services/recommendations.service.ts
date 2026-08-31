import { Inject, Injectable } from '@nestjs/common';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  PRIVACY_SERVICE,
  type IPrivacyService,
} from 'src/modules/privacy/interfaces/privacy.interface';
import type { SuggestionView } from '../interfaces/social.interface';
import { FollowRepository } from '../repositories/follow.repository';
import { FriendshipRepository } from '../repositories/friendship.repository';
import { CardResolver } from './card.resolver';
import { TrendingHostsStore } from './trending-hosts.store';

/** Machine reason codes (client localizes them). */
export const RECOMMENDATION_REASON = {
  MUTUAL: 'MUTUAL_FRIENDS',
  POPULAR: 'POPULAR',
  TRENDING: 'TRENDING_HOST',
} as const;

export type RecommendationKind = 'mutual' | 'popular' | 'trending' | 'all';

interface Candidate {
  userId: string;
  reason: string;
  score: number;
  mutualCount: number | null;
}

/**
 * Backend-driven user recommendations — deterministic, non-AI heuristics over
 * the social graph: friends-of-friends (mutual), most-followed (popular) and
 * trending hosts (Redis). Always excludes self, existing follows/friends and
 * blocked users. Score bands keep mutual above popular above trending in the
 * merged "all" view.
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly follows: FollowRepository,
    private readonly friendships: FriendshipRepository,
    private readonly trending: TrendingHostsStore,
    private readonly cards: CardResolver,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
  ) {}

  async recommend(
    userId: string,
    kind: RecommendationKind,
    page: number,
    limit: number,
  ): Promise<Paginated<SuggestionView>> {
    const [followingIds, friendIds, blocked] = await Promise.all([
      this.follows.followingIds(userId),
      this.friendships.friendIds(userId),
      this.privacy.blockedIdsFor(userId),
    ]);
    const exclude = new Set<string>([userId, ...followingIds, ...friendIds, ...blocked]);

    const candidates: Candidate[] = [];
    if (kind === 'mutual' || kind === 'all') {
      candidates.push(...(await this.mutual(friendIds, exclude)));
    }
    if (kind === 'popular' || kind === 'all') {
      candidates.push(...(await this.popular(exclude, limit * 3)));
    }
    if (kind === 'trending' || kind === 'all') {
      candidates.push(...(await this.trendingHosts(exclude, limit * 3)));
    }

    // Dedupe by user, keeping the strongest signal.
    const byId = new Map<string, Candidate>();
    for (const c of candidates) {
      const existing = byId.get(c.userId);
      if (!existing || c.score > existing.score) byId.set(c.userId, c);
    }
    const merged = [...byId.values()].sort((a, b) => b.score - a.score);

    const total = merged.length;
    const slice = merged.slice((page - 1) * limit, (page - 1) * limit + limit);
    const cards = await this.cards.resolve(slice.map((c) => c.userId), userId);
    const cardById = new Map(cards.map((c) => [c.userId, c]));

    const items: SuggestionView[] = [];
    for (const c of slice) {
      const card = cardById.get(c.userId);
      if (!card) continue;
      items.push({ ...card, reason: c.reason, score: c.score, mutualCount: c.mutualCount });
    }
    return buildPaginated(items, total, page, limit);
  }

  private async mutual(friendIds: string[], exclude: Set<string>): Promise<Candidate[]> {
    if (friendIds.length === 0) return [];
    const lists = await Promise.all(friendIds.map((f) => this.friendships.friendIds(f)));
    const counts = new Map<string, number>();
    for (const list of lists) {
      for (const id of list) {
        if (exclude.has(id)) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([userId, count]) => ({
      userId,
      reason: RECOMMENDATION_REASON.MUTUAL,
      score: 100 + count,
      mutualCount: count,
    }));
  }

  private async popular(exclude: Set<string>, take: number): Promise<Candidate[]> {
    const rows = await this.follows.topFollowed(take + exclude.size);
    return rows
      .filter((r) => !exclude.has(r.userId))
      .slice(0, take)
      .map((r) => ({
        userId: r.userId,
        reason: RECOMMENDATION_REASON.POPULAR,
        score: 50 + Math.min(9, Math.log10(r.count + 1) * 3),
        mutualCount: null,
      }));
  }

  private async trendingHosts(exclude: Set<string>, take: number): Promise<Candidate[]> {
    const top = await this.trending.top(take + exclude.size);
    return top
      .filter((t) => !exclude.has(t.userId))
      .slice(0, take)
      .map((t) => ({
        userId: t.userId,
        reason: RECOMMENDATION_REASON.TRENDING,
        score: 40 + Math.min(9, t.score),
        mutualCount: null,
      }));
  }
}
