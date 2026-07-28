import { Injectable } from '@nestjs/common';

/**
 * Calendar arithmetic for the streak, kept free of Prisma and Redis so the
 * edge cases that actually break this feature — zone offsets, month and leap
 * boundaries — are testable in isolation.
 *
 * `en-CA` is used deliberately: it formats as YYYY-MM-DD, which is both the
 * storage format and lexicographically sortable.
 */
@Injectable()
export class AttendanceDayService {
  /**
   * Upper bound on hourly probes in `nextBoundary`. The longest civil day
   * recorded in the IANA tz database is 25 hours (a DST fall-back, e.g.
   * Europe/London on 2026-10-25); this carries 2h of deliberate headroom
   * above that so a legitimate day never gets misjudged as exhausted.
   */
  private static readonly MAX_PROBE_HOURS = 27;
  /** Local calendar date in `timezone` at instant `at`, as `YYYY-MM-DD`. */
  dayKey(at: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }

  /** The calendar date one day before `dayKey`. */
  previousDayKey(dayKey: string): string {
    const [y, m, d] = dayKey.split('-').map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d));
    utc.setUTCDate(utc.getUTCDate() - 1);
    return utc.toISOString().slice(0, 10);
  }

  /**
   * The first probed instant at or shortly after `timezone`'s next local
   * midnight. Because minute-narrowing is anchored to `at.getTime()` rather
   * than wall-clock minutes, the result can land up to 59s after true local
   * midnight — but it is never before it. Found by probing forward rather
   * than computing an offset, so DST transitions need no special handling.
   *
   * @throws {Error} if the local date does not change within
   *   `MAX_PROBE_HOURS` hours of `at`. That bound already has headroom above
   *   every known civil day length, so hitting it means `timezone` is
   *   invalid or something else is badly wrong — throwing surfaces that as a
   *   failed (retryable) claim instead of silently mislabelling an instant
   *   still inside the current day as the next boundary.
   */
  nextBoundary(at: Date, timezone: string): Date {
    const today = this.dayKey(at, timezone);
    const hour = 60 * 60 * 1000;
    // Walk forward one hour at a time until the local date changes, then
    // narrow to the minute.
    let cursor = at.getTime();
    let changed = false;
    for (let i = 0; i < AttendanceDayService.MAX_PROBE_HOURS; i += 1) {
      cursor += hour;
      if (this.dayKey(new Date(cursor), timezone) !== today) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      throw new Error(
        `AttendanceDayService.nextBoundary: no calendar-day change found for timezone "${timezone}" within ${AttendanceDayService.MAX_PROBE_HOURS}h of ${at.toISOString()}`,
      );
    }
    let lower = cursor - hour;
    while (lower < cursor) {
      const mid = lower + 60_000;
      if (this.dayKey(new Date(mid), timezone) !== today) {
        return new Date(mid);
      }
      lower = mid;
    }
    return new Date(cursor);
  }
}
