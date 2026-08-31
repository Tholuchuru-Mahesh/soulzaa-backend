import {
  isValidIsoWeekKey,
  isoWeekKeyRange,
  isoWeekKeyUtc,
  isoWeekStartUtc,
  isoWeekWindowUtc,
  monthKeyUtc,
  shiftIsoWeekKey,
} from './iso-week.util';

describe('iso-week.util', () => {
  describe('isoWeekKeyUtc', () => {
    it('keys a mid-week instant', () => {
      // 2026-09-02 is a Wednesday → ISO week 36 of 2026.
      expect(isoWeekKeyUtc(new Date('2026-09-02T12:00:00Z'))).toBe('2026W36');
    });

    it('a week belongs to the ISO year containing its Thursday', () => {
      // 2027-01-01 is a Friday; that week's Thursday is 2026-12-31.
      expect(isoWeekKeyUtc(new Date('2027-01-01T00:00:00Z'))).toBe('2026W53');
      // 2024-12-31 is a Tuesday; that week's Thursday is 2025-01-02.
      expect(isoWeekKeyUtc(new Date('2024-12-31T00:00:00Z'))).toBe('2025W01');
    });

    it('Monday 00:00Z and the last second before the next Monday share a key', () => {
      const monday = new Date('2026-08-31T00:00:00Z');
      const sundayNight = new Date('2026-09-06T23:59:59Z');
      expect(isoWeekKeyUtc(monday)).toBe(isoWeekKeyUtc(sundayNight));
      // The next Monday flips it.
      expect(isoWeekKeyUtc(new Date('2026-09-07T00:00:00Z'))).not.toBe(
        isoWeekKeyUtc(monday),
      );
    });
  });

  describe('isoWeekStartUtc / isoWeekWindowUtc', () => {
    it('starts a week on Monday 00:00:00Z', () => {
      const start = isoWeekStartUtc('2026W36');
      expect(start.getUTCDay()).toBe(1); // Monday
      expect(start.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    });

    it('window is a half-open 7-day span', () => {
      const { start, end } = isoWeekWindowUtc('2026W36');
      expect(end.getTime() - start.getTime()).toBe(7 * 86_400_000);
      expect(isoWeekKeyUtc(start)).toBe('2026W36');
      expect(isoWeekKeyUtc(new Date(end.getTime() - 1))).toBe('2026W36');
      expect(isoWeekKeyUtc(end)).toBe('2026W37');
    });

    it('round-trips a key it produced', () => {
      const key = isoWeekKeyUtc(new Date('2026-02-14T09:30:00Z'));
      expect(isoWeekKeyUtc(isoWeekStartUtc(key))).toBe(key);
    });
  });

  describe('shiftIsoWeekKey', () => {
    it('walks backward and forward across a year boundary', () => {
      expect(shiftIsoWeekKey('2026W01', -1)).toBe('2025W52');
      expect(shiftIsoWeekKey('2025W52', 1)).toBe('2026W01');
      expect(shiftIsoWeekKey('2026W36', -12)).toBe('2026W24');
    });
  });

  describe('isoWeekKeyRange', () => {
    it('is inclusive and chronological', () => {
      const keys = isoWeekKeyRange('2026W34', '2026W37');
      expect(keys).toEqual(['2026W34', '2026W35', '2026W36', '2026W37']);
    });
    it('is a single element when from === to', () => {
      expect(isoWeekKeyRange('2026W10', '2026W10')).toEqual(['2026W10']);
    });
    it('is empty when reversed', () => {
      expect(isoWeekKeyRange('2026W20', '2026W10')).toEqual([]);
    });
  });

  describe('isValidIsoWeekKey', () => {
    it('accepts real keys and rejects malformed / impossible ones', () => {
      expect(isValidIsoWeekKey('2026W36')).toBe(true);
      expect(isValidIsoWeekKey('2020W53')).toBe(true); // 2020-12-31 is a Thursday → 53 weeks
      expect(isValidIsoWeekKey('2025W53')).toBe(false); // 2025 has only 52 ISO weeks
      expect(isValidIsoWeekKey('2026-36')).toBe(false);
      expect(isValidIsoWeekKey('2026W00')).toBe(false);
      expect(isValidIsoWeekKey('26W36')).toBe(false);
    });
  });

  describe('monthKeyUtc', () => {
    it('formats YYYY-MM in UTC', () => {
      expect(monthKeyUtc(new Date('2026-01-05T23:00:00Z'))).toBe('2026-01');
      expect(monthKeyUtc(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
    });
  });
});
