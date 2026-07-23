import { Injectable } from '@nestjs/common';

export type RankingPeriodName =
  'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'alltime' | 'custom';

/**
 * `utc` is the VR-13 default and the only correct choice for a global ladder:
 * a "daily" ranking must close at the same instant for every user on earth.
 *
 * `local` exists solely to preserve the pre-existing RankingsService behaviour,
 * which derives daily/monthly keys from local calendar fields. Changing that
 * would silently shift the day boundary of ladders already in production, so
 * the legacy caller opts into it explicitly rather than the resolver quietly
 * "fixing" it.
 */
export type RankingTimezone = 'utc' | 'local';

/** Periods materialised on the write path. */
const HOT: readonly RankingPeriodName[] = ['hourly', 'daily', 'weekly', 'monthly', 'alltime'];

/** Periods produced by ZUNIONSTORE over hot keys, never incremented directly. */
const DERIVED: readonly RankingPeriodName[] = ['quarterly', 'yearly'];

const PATTERNS: Record<string, RegExp> = {
  hourly: /^\d{10}$/,
  daily: /^\d{8}$/,
  weekly: /^\d{4}W\d{2}$/,
  monthly: /^\d{6}$/,
  quarterly: /^\d{4}Q[1-4]$/,
  yearly: /^\d{4}$/,
  alltime: /^alltime$/,
};

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

@Injectable()
export class RankingPeriodResolver {
  readonly HOT_PERIODS = HOT;
  readonly DERIVED_PERIODS = DERIVED;

  /**
   * The bucket key `date` falls into for `period`.
   *
   * `custom` throws: a custom range is defined by its caller-supplied bounds,
   * so there is no key to derive from a single instant. Returning something
   * plausible here would silently write custom-range data into a bucket nobody
   * queries.
   */
  dateKeyFor(period: RankingPeriodName, date: Date, tz: RankingTimezone = 'utc'): string {
    if (period === 'alltime') return 'alltime';
    if (period === 'custom') {
      throw new Error('dateKeyFor: "custom" has no derivable date key — supply one explicitly');
    }

    const y = tz === 'utc' ? date.getUTCFullYear() : date.getFullYear();
    const m = (tz === 'utc' ? date.getUTCMonth() : date.getMonth()) + 1;
    const d = tz === 'utc' ? date.getUTCDate() : date.getDate();
    const h = tz === 'utc' ? date.getUTCHours() : date.getHours();

    switch (period) {
      case 'hourly':
        return `${y}${pad(m)}${pad(d)}${pad(h)}`;
      case 'daily':
        return `${y}${pad(m)}${pad(d)}`;
      case 'monthly':
        return `${y}${pad(m)}`;
      case 'quarterly':
        return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
      case 'yearly':
        return `${y}`;
      case 'weekly':
        return this.isoWeekKey(date, tz);
    }
  }

  /**
   * ISO-8601 week key. A week belongs to the year containing its Thursday,
   * which is why 2027-01-01 lands in 2026W53 and 2024-12-31 in 2025W01.
   * Always computed on a UTC-normalised copy so the arithmetic below cannot be
   * perturbed by a DST shift in the host timezone.
   */
  private isoWeekKey(date: Date, tz: RankingTimezone): string {
    const y = tz === 'utc' ? date.getUTCFullYear() : date.getFullYear();
    const m = tz === 'utc' ? date.getUTCMonth() : date.getMonth();
    const d = tz === 'utc' ? date.getUTCDate() : date.getDate();

    const t = new Date(Date.UTC(y, m, d));
    const dayNum = t.getUTCDay() || 7; // Sunday 0 → 7
    t.setUTCDate(t.getUTCDate() + 4 - dayNum); // move to this week's Thursday
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}W${pad(week)}`;
  }

  /** Half-open `[start, end)` UTC window a dateKey covers. */
  windowFor(period: RankingPeriodName, dateKey: string): { start: Date; end: Date } {
    if (period === 'alltime') {
      return { start: new Date(0), end: new Date(Date.UTC(9999, 0, 1)) };
    }
    // Checked explicitly before the isValidDateKey guard: PATTERNS has no
    // 'custom' entry, so isValidDateKey('custom', ...) always returns false
    // and would otherwise mask this case behind the generic "not a valid
    // date key" message below, misdescribing the actual problem.
    if (period === 'custom') {
      throw new Error('windowFor: "custom" bounds must be supplied by the caller');
    }
    if (!this.isValidDateKey(period, dateKey)) {
      throw new Error(`windowFor: "${dateKey}" is not a valid ${period} date key`);
    }

    const y = Number(dateKey.slice(0, 4));

    switch (period) {
      case 'hourly': {
        const start = new Date(
          Date.UTC(
            y,
            Number(dateKey.slice(4, 6)) - 1,
            Number(dateKey.slice(6, 8)),
            Number(dateKey.slice(8, 10)),
          ),
        );
        return { start, end: new Date(start.getTime() + 3_600_000) };
      }
      case 'daily': {
        const start = new Date(
          Date.UTC(y, Number(dateKey.slice(4, 6)) - 1, Number(dateKey.slice(6, 8))),
        );
        return { start, end: new Date(start.getTime() + 86_400_000) };
      }
      case 'weekly': {
        const start = this.isoWeekStart(y, Number(dateKey.slice(5)));
        return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
      }
      case 'monthly': {
        const mo = Number(dateKey.slice(4, 6)) - 1;
        return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) };
      }
      case 'quarterly': {
        const q = Number(dateKey.slice(5));
        return {
          start: new Date(Date.UTC(y, (q - 1) * 3, 1)),
          end: new Date(Date.UTC(y, q * 3, 1)),
        };
      }
      case 'yearly':
        return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
      // No 'custom' arm here: the explicit period === 'custom' check above
      // always throws, so TypeScript narrows 'custom' out of this switch's
      // domain entirely — keeping a case for it would be a type error, not
      // just dead code.
    }
  }

  /** Monday 00:00:00Z of ISO week `week` in ISO year `isoYear`. */
  private isoWeekStart(isoYear: number, week: number): Date {
    // Jan 4 is always in ISO week 1.
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86_400_000);
    return new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
  }

  /**
   * The hot keys a derived period unions over. Monthly is the union unit for
   * both quarterly and yearly: unioning 365 daily keys would be a far larger
   * ZUNIONSTORE for an identical result.
   */
  constituentsOf(
    period: RankingPeriodName,
    dateKey: string,
  ): { period: RankingPeriodName; dateKey: string }[] {
    if (period === 'quarterly') {
      const y = dateKey.slice(0, 4);
      const first = (Number(dateKey.slice(5)) - 1) * 3 + 1;
      return [0, 1, 2].map((i) => ({
        period: 'monthly' as const,
        dateKey: `${y}${pad(first + i)}`,
      }));
    }
    if (period === 'yearly') {
      return Array.from({ length: 12 }, (_, i) => ({
        period: 'monthly' as const,
        dateKey: `${dateKey}${pad(i + 1)}`,
      }));
    }
    return [];
  }

  /**
   * Shape check plus a real-date check. The shape alone would accept '20260732'
   * and '2026W54', which look right and index nothing.
   */
  isValidDateKey(period: RankingPeriodName, dateKey: string): boolean {
    const pattern = PATTERNS[period];
    if (!pattern || !pattern.test(dateKey)) return false;

    if (period === 'alltime') return true;

    const y = Number(dateKey.slice(0, 4));

    if (period === 'weekly') {
      const w = Number(dateKey.slice(5));
      if (w < 1 || w > 53) return false;
      // A 53rd week exists only when the ISO year actually has one.
      return w !== 53 || this.isoWeeksInYear(y) === 53;
    }

    if (period === 'monthly' || period === 'daily' || period === 'hourly') {
      const mo = Number(dateKey.slice(4, 6));
      if (mo < 1 || mo > 12) return false;
      if (period === 'monthly') return true;

      const day = Number(dateKey.slice(6, 8));
      if (day < 1 || day > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
      if (period === 'daily') return true;

      const hour = Number(dateKey.slice(8, 10));
      return hour >= 0 && hour <= 23;
    }

    return true; // quarterly + yearly are fully constrained by their patterns
  }

  /** An ISO year has 53 weeks iff Jan 1 or Dec 31 falls on a Thursday. */
  private isoWeeksInYear(isoYear: number): number {
    const jan1 = new Date(Date.UTC(isoYear, 0, 1)).getUTCDay();
    const dec31 = new Date(Date.UTC(isoYear, 11, 31)).getUTCDay();
    return jan1 === 4 || dec31 === 4 ? 53 : 52;
  }
}
