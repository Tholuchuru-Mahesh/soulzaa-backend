import { Inject, Injectable } from '@nestjs/common';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import type { MemberScore } from '../interfaces/agency-member.interface';
import { AgencyMemberScoreService } from './agency-member-score.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;

/** How far back each tab on the leaderboard looks. */
export type LeaderboardRange = 'daily' | 'weekly' | 'monthly';

const RANGE_DAYS: Record<LeaderboardRange, number> = { daily: 1, weekly: 7, monthly: 30 };

/**
 * The agency leaderboard — the same engagement ranking the member profile
 * shows, over a chosen window.
 *
 * Deliberately the same engine rather than a second one: a member who reads
 * "Rank in Agency #7" on their profile and taps through to the leaderboard has
 * to find themselves at #7. Two different measures of "rank" on two screens one
 * tap apart reads as a bug, whichever is right.
 *
 * `monthly` uses the profile's own 30-day window, which is why it is the
 * default. Daily and Weekly measure shorter windows and will legitimately
 * differ — the tab labels are what explain that to the reader.
 */
@Injectable()
export class AgencyLeaderboardService {
  constructor(
    private readonly scores: AgencyMemberScoreService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  async getLeaderboard(
    agencyId: string,
    options: { range?: LeaderboardRange; page?: number; limit?: number } = {},
  ) {
    const range = options.range ?? 'monthly';
    const days = RANGE_DAYS[range] ?? RANGE_DAYS.monthly;
    const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_PAGE_SIZE);
    const page = Math.max(options.page ?? 1, 1);

    const now = new Date();
    // The window immediately before this one, so "change" compares like with
    // like: this week against last week, not this week against all time.
    const previousEnd = new Date(now.getTime() - days * DAY_MS);

    const [current, previous] = await Promise.all([
      this.scores.rankAgencyOver(agencyId, days, range, now),
      this.scores.rankAgencyOver(agencyId, days, `${range}-prev`, previousEnd),
    ]);

    const ordered = [...current.values()].sort((a, b) => a.rank - b.rank);
    const total = ordered.length;
    const pageRows = ordered.slice((page - 1) * limit, page * limit);

    const identities = await this.profiles.resolvePublicIdentities(
      pageRows.map((row) => row.userId),
    );

    return {
      range,
      items: pageRows.map((row) => ({
        rank: row.rank,
        userId: row.userId,
        displayName: identities.get(row.userId)?.displayName ?? null,
        avatarUrl: identities.get(row.userId)?.avatarUrl ?? null,
        score: row.score,
        change: this.changeFor(row, previous),
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Places moved since the previous window: positive is a climb.
   *
   * Null for a member who was not ranked last period — they have not moved,
   * they have arrived, and "+0" would say something untrue about a new entrant.
   */
  private changeFor(row: MemberScore, previous: Map<string, MemberScore>): number | null {
    const before = previous.get(row.userId);
    if (!before) return null;
    return before.rank - row.rank;
  }
}
