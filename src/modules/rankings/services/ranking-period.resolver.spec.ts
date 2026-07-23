import { RankingPeriodResolver } from './ranking-period.resolver';

describe('RankingPeriodResolver', () => {
  const resolver = new RankingPeriodResolver();
  // 2026-07-22T14:35:00Z — a Wednesday in ISO week 30, Q3.
  const d = new Date('2026-07-22T14:35:00.000Z');

  describe('dateKeyFor (utc)', () => {
    it('formats every period', () => {
      expect(resolver.dateKeyFor('hourly', d)).toBe('2026072214');
      expect(resolver.dateKeyFor('daily', d)).toBe('20260722');
      expect(resolver.dateKeyFor('weekly', d)).toBe('2026W30');
      expect(resolver.dateKeyFor('monthly', d)).toBe('202607');
      expect(resolver.dateKeyFor('quarterly', d)).toBe('2026Q3');
      expect(resolver.dateKeyFor('yearly', d)).toBe('2026');
      expect(resolver.dateKeyFor('alltime', d)).toBe('alltime');
    });

    it('pads single-digit months, days and hours', () => {
      const early = new Date('2026-01-05T03:00:00.000Z');
      expect(resolver.dateKeyFor('hourly', early)).toBe('2026010503');
      expect(resolver.dateKeyFor('daily', early)).toBe('20260105');
      expect(resolver.dateKeyFor('monthly', early)).toBe('202601');
    });

    it('assigns Jan 1 2027 (a Friday) to ISO week 53 of 2026', () => {
      // ISO-8601: a week belongs to the year containing its Thursday.
      expect(resolver.dateKeyFor('weekly', new Date('2027-01-01T00:00:00.000Z'))).toBe('2026W53');
    });

    it('assigns Dec 31 2024 (a Tuesday) to ISO week 1 of 2025', () => {
      expect(resolver.dateKeyFor('weekly', new Date('2024-12-31T00:00:00.000Z'))).toBe('2025W01');
    });

    it('maps month boundaries to the right quarter', () => {
      expect(resolver.dateKeyFor('quarterly', new Date('2026-03-31T23:59:59Z'))).toBe('2026Q1');
      expect(resolver.dateKeyFor('quarterly', new Date('2026-04-01T00:00:00Z'))).toBe('2026Q2');
      expect(resolver.dateKeyFor('quarterly', new Date('2026-12-31T23:59:59Z'))).toBe('2026Q4');
    });

    it('throws for custom, which has no derivable key', () => {
      expect(() => resolver.dateKeyFor('custom', d)).toThrow(/custom/i);
    });
  });

  describe('dateKeyFor (local) — preserves legacy RankingsService behaviour', () => {
    it('uses local calendar fields rather than UTC', () => {
      const local = resolver.dateKeyFor('daily', d, 'local');
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      expect(local).toBe(`${yyyy}${mm}${dd}`);
    });
  });

  describe('windowFor', () => {
    it('returns a half-open [start, end) window per period', () => {
      expect(resolver.windowFor('daily', '20260722')).toEqual({
        start: new Date('2026-07-22T00:00:00.000Z'),
        end: new Date('2026-07-23T00:00:00.000Z'),
      });
      expect(resolver.windowFor('hourly', '2026072214')).toEqual({
        start: new Date('2026-07-22T14:00:00.000Z'),
        end: new Date('2026-07-22T15:00:00.000Z'),
      });
      expect(resolver.windowFor('monthly', '202607')).toEqual({
        start: new Date('2026-07-01T00:00:00.000Z'),
        end: new Date('2026-08-01T00:00:00.000Z'),
      });
      expect(resolver.windowFor('quarterly', '2026Q3')).toEqual({
        start: new Date('2026-07-01T00:00:00.000Z'),
        end: new Date('2026-10-01T00:00:00.000Z'),
      });
      expect(resolver.windowFor('yearly', '2026')).toEqual({
        start: new Date('2026-01-01T00:00:00.000Z'),
        end: new Date('2027-01-01T00:00:00.000Z'),
      });
    });

    it('rolls December into the next year', () => {
      expect(resolver.windowFor('monthly', '202612').end).toEqual(
        new Date('2027-01-01T00:00:00.000Z'),
      );
    });

    it('starts an ISO week on Monday 00:00Z', () => {
      const { start, end } = resolver.windowFor('weekly', '2026W30');
      expect(start.getUTCDay()).toBe(1);
      expect(end.getTime() - start.getTime()).toBe(7 * 86_400_000);
    });

    it('spans the epoch-to-far-future for alltime', () => {
      const { start, end } = resolver.windowFor('alltime', 'alltime');
      expect(start.getTime()).toBe(0);
      expect(end.getTime()).toBeGreaterThan(Date.now());
    });

    // 'custom' is checked explicitly before isValidDateKey (which always
    // returns false for 'custom', since PATTERNS has no 'custom' entry) so
    // this specific message fires instead of the generic invalid-key error.
    it('throws the specific custom-bounds message for period "custom"', () => {
      expect(() => resolver.windowFor('custom', 'anything')).toThrow(/custom.*bounds/i);
    });
  });

  describe('constituentsOf', () => {
    it('decomposes a quarter into its three months', () => {
      expect(resolver.constituentsOf('quarterly', '2026Q3')).toEqual([
        { period: 'monthly', dateKey: '202607' },
        { period: 'monthly', dateKey: '202608' },
        { period: 'monthly', dateKey: '202609' },
      ]);
    });

    it('decomposes a year into twelve months', () => {
      const parts = resolver.constituentsOf('yearly', '2026');
      expect(parts).toHaveLength(12);
      expect(parts[0]).toEqual({ period: 'monthly', dateKey: '202601' });
      expect(parts[11]).toEqual({ period: 'monthly', dateKey: '202612' });
    });

    it('returns nothing for a hot period — it is materialised, not derived', () => {
      expect(resolver.constituentsOf('daily', '20260722')).toEqual([]);
      expect(resolver.constituentsOf('alltime', 'alltime')).toEqual([]);
    });
  });

  describe('isValidDateKey', () => {
    it('accepts well-formed keys', () => {
      expect(resolver.isValidDateKey('daily', '20260722')).toBe(true);
      expect(resolver.isValidDateKey('weekly', '2026W30')).toBe(true);
      expect(resolver.isValidDateKey('alltime', 'alltime')).toBe(true);
    });

    it('rejects malformed keys, wrong-period keys and impossible dates', () => {
      expect(resolver.isValidDateKey('daily', '2026-07-22')).toBe(false);
      expect(resolver.isValidDateKey('daily', '202607')).toBe(false);
      expect(resolver.isValidDateKey('weekly', '2026W54')).toBe(false);
      expect(resolver.isValidDateKey('monthly', '202613')).toBe(false);
      expect(resolver.isValidDateKey('quarterly', '2026Q5')).toBe(false);
      expect(resolver.isValidDateKey('daily', '20260732')).toBe(false);
      expect(resolver.isValidDateKey('alltime', '20260722')).toBe(false);
    });

    it('rejects a 53rd ISO week in a year that only has 52 (2027), and accepts it in a year that has 53 (2026)', () => {
      expect(resolver.isValidDateKey('weekly', '2027W53')).toBe(false);
      expect(resolver.isValidDateKey('weekly', '2026W53')).toBe(true);
    });
  });
});
