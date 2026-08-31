import { Injectable } from '@nestjs/common';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  isValidIsoWeekKey,
  isoWeekWindowUtc,
  monthKeyUtc,
  shiftIsoWeekKey,
} from 'src/common/utils/iso-week.util';
import type {
  ContributionHistoryQueryDto,
  ContributionLeaderboardQueryDto,
  WeeklyContributionQueryDto,
} from '../dto/contributions.dto';
import {
  WeeklyContributionRepository,
  type MonthBucket,
  type WeekBucket,
} from '../repositories/weekly-contribution.repository';

/**
 * Read model for the Super Admin "Contributions" section: current week, last
 * week, week-wise / month-wise history and per-week leaderboards. Everything is
 * backed by the per-week buckets, with the immutable `GiftTransaction` ledger as
 * the fallback for any week that predates the buckets. Lifetime totals remain
 * available on the legacy `*ContributionCounter` tables.
 */
@Injectable()
export class WeeklyContributionService {
  constructor(private readonly repo: WeeklyContributionRepository) {}

  /** Current week's total (+ last week for comparison). */
  async weekly(q: WeeklyContributionQueryDto): Promise<{
    scope: string;
    id: string;
    current: WeekBucket;
    previous: WeekBucket;
    deltaPct: number | null;
  }> {
    const weekKey =
      q.weekKey && isValidIsoWeekKey(q.weekKey) ? q.weekKey : this.repo.currentWeekKey();
    const prevKey = shiftIsoWeekKey(weekKey, -1);

    const [current, previous] = await Promise.all([
      this.repo.getWeekBucket(q.scope, q.id, weekKey),
      this.repo.getWeekBucket(q.scope, q.id, prevKey),
    ]);

    const deltaPct =
      previous.amount > 0
        ? Math.round(((current.amount - previous.amount) / previous.amount) * 1000) / 10
        : null;

    return { scope: q.scope, id: q.id, current, previous, deltaPct };
  }

  /** Week-wise or month-wise history over a range (defaults to the last 12 weeks). */
  async history(q: ContributionHistoryQueryDto): Promise<Paginated<WeekBucket | MonthBucket>> {
    if (q.granularity === 'month') {
      const { from, to } = await this.resolveMonthRange(q);
      const rows = await this.repo.monthHistory(q.scope, q.id, from, to);
      // Newest first for the table.
      const ordered = rows.slice().reverse();
      const page = ordered.slice(q.skip, q.skip + q.limit);
      return buildPaginated<WeekBucket | MonthBucket>(page, ordered.length, q.page, q.limit);
    }

    const toKey = q.to && isValidIsoWeekKey(q.to) ? q.to : this.repo.currentWeekKey();
    const fromKey = await this.resolveFromWeekKey(q, toKey);
    const rows = await this.repo.listWeekBuckets(q.scope, q.id, fromKey, toKey);
    const ordered = rows.slice().reverse(); // newest week first
    const page = ordered.slice(q.skip, q.skip + q.limit);
    return buildPaginated<WeekBucket | MonthBucket>(page, ordered.length, q.page, q.limit);
  }

  /** Top rooms / users by contribution for one week. */
  async leaderboard(q: ContributionLeaderboardQueryDto): Promise<{
    weekKey: string;
    weekStart: string;
    weekEnd: string;
    rows: { id: string; amount: number }[];
  }> {
    const weekKey =
      q.weekKey && isValidIsoWeekKey(q.weekKey) ? q.weekKey : this.repo.currentWeekKey();
    const { start, end } = isoWeekWindowUtc(weekKey);
    const rows = await this.repo.weekLeaderboard(q.scope, weekKey, q.limit);
    return {
      weekKey,
      weekStart: start.toISOString(),
      weekEnd: end.toISOString(),
      rows,
    };
  }

  // ---- range resolution ----

  private async resolveFromWeekKey(q: ContributionHistoryQueryDto, toKey: string): Promise<string> {
    if (q.from && isValidIsoWeekKey(q.from)) return q.from;
    // Default window: the last 12 weeks up to and including `toKey`.
    return shiftIsoWeekKey(toKey, -11);
  }

  private async resolveMonthRange(
    q: ContributionHistoryQueryDto,
  ): Promise<{ from: Date; to: Date }> {
    const parseMonth = (k?: string): Date | null =>
      k && /^\d{4}-\d{2}$/.test(k)
        ? new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, 1))
        : null;

    const now = new Date();
    const toMonthStart =
      parseMonth(q.to) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = new Date(Date.UTC(toMonthStart.getUTCFullYear(), toMonthStart.getUTCMonth() + 1, 1));

    let from = parseMonth(q.from);
    if (!from) {
      const first = await this.repo.firstGiftAt(q.scope, q.id);
      from = first
        ? new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1))
        : new Date(Date.UTC(toMonthStart.getUTCFullYear(), toMonthStart.getUTCMonth() - 11, 1));
    }
    return { from, to };
  }

  /** The month key an instant falls in (exposed for callers/tests). */
  monthKey(date: Date): string {
    return monthKeyUtc(date);
  }
}
