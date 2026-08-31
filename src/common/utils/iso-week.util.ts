/**
 * ISO-8601 week helpers, always computed in UTC.
 *
 * A week is Monday 00:00:00Z .. next Monday 00:00:00Z (half-open) and belongs to
 * the ISO year containing its Thursday — so 2027-01-01 is `2026W53` and
 * 2024-12-31 is `2025W01`. The key format is `${isoYear}W${paddedWeek}` (e.g.
 * `2026W36`), identical to the format `RankingPeriodResolver` produces; that
 * resolver delegates its week math here so there is a single implementation.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The ISO week key (`YYYYWNN`) the given instant falls in. */
export function isoWeekKeyUtc(date: Date = new Date()): string {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Sunday 0 -> 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // this week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}W${pad2(week)}`;
}

/** The ISO week key for right now. */
export function currentIsoWeekKeyUtc(): string {
  return isoWeekKeyUtc(new Date());
}

/** Monday 00:00:00Z of a given ISO week key. */
export function isoWeekStartUtc(weekKey: string): Date {
  const { isoYear, week } = parseIsoWeekKey(weekKey);
  // Jan 4 is always in ISO week 1.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * DAY_MS);
  return new Date(week1Monday.getTime() + (week - 1) * WEEK_MS);
}

/** Half-open `[start, end)` UTC window for an ISO week key. */
export function isoWeekWindowUtc(weekKey: string): { start: Date; end: Date } {
  const start = isoWeekStartUtc(weekKey);
  return { start, end: new Date(start.getTime() + WEEK_MS) };
}

/** The ISO week key `n` weeks before `weekKey` (n may be negative). */
export function shiftIsoWeekKey(weekKey: string, deltaWeeks: number): string {
  const start = isoWeekStartUtc(weekKey);
  return isoWeekKeyUtc(new Date(start.getTime() + deltaWeeks * WEEK_MS));
}

/** Every ISO week key in `[fromKey, toKey]` inclusive, chronologically. */
export function isoWeekKeyRange(fromKey: string, toKey: string): string[] {
  const end = isoWeekStartUtc(toKey).getTime();
  const keys: string[] = [];
  let cursor = isoWeekStartUtc(fromKey).getTime();
  // Guard against a reversed range / runaway loop (cap ~10 years of weeks).
  for (let i = 0; cursor <= end && i < 520; i++) {
    keys.push(isoWeekKeyUtc(new Date(cursor)));
    cursor += WEEK_MS;
  }
  return keys;
}

/** `true` for a syntactically + calendar-valid ISO week key. */
export function isValidIsoWeekKey(weekKey: string): boolean {
  if (!/^\d{4}W\d{2}$/.test(weekKey)) return false;
  const { isoYear, week } = parseIsoWeekKey(weekKey);
  if (week < 1 || week > 53) return false;
  if (week !== 53) return true;
  // A 53rd week exists only when the ISO year actually has one (Jan 1 or Dec 31
  // is a Thursday).
  const jan1 = new Date(Date.UTC(isoYear, 0, 1)).getUTCDay();
  const dec31 = new Date(Date.UTC(isoYear, 11, 31)).getUTCDay();
  return jan1 === 4 || dec31 === 4;
}

function parseIsoWeekKey(weekKey: string): { isoYear: number; week: number } {
  return {
    isoYear: Number(weekKey.slice(0, 4)),
    week: Number(weekKey.slice(5)),
  };
}

/** The calendar-month key (`YYYY-MM`, UTC) an instant falls in. */
export function monthKeyUtc(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}
