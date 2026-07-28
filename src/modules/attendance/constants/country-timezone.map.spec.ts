import { resolveTimezone, COUNTRY_TIMEZONES } from './country-timezone.map';

describe('resolveTimezone', () => {
  it('maps a known country to its canonical zone', () => {
    expect(resolveTimezone('IN')).toBe('Asia/Kolkata');
    expect(resolveTimezone('US')).toBe('America/New_York');
    expect(resolveTimezone('AE')).toBe('Asia/Dubai');
  });

  it('accepts lower-case and padded country codes', () => {
    expect(resolveTimezone(' in ')).toBe('Asia/Kolkata');
  });

  it('falls back to UTC for an unmapped country', () => {
    expect(resolveTimezone('ZZ')).toBe('UTC');
  });

  it('falls back to UTC when the user has no country', () => {
    // User.country is nullable — a profile may never have set one.
    expect(resolveTimezone(null)).toBe('UTC');
    expect(resolveTimezone(undefined)).toBe('UTC');
    expect(resolveTimezone('')).toBe('UTC');
  });

  it('only returns zones the runtime can actually format', () => {
    // A typo in the table would surface as a RangeError at claim time.
    for (const zone of Object.values(COUNTRY_TIMEZONES)) {
      expect(() =>
        new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(0)),
      ).not.toThrow();
    }
  });
});
