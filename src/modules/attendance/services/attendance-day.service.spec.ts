import { AttendanceDayService } from './attendance-day.service';

describe('AttendanceDayService', () => {
  const svc = new AttendanceDayService();

  it('formats the local date for a zone ahead of UTC', () => {
    // 2026-07-27T20:00Z is 2026-07-28 01:30 in Kolkata (+05:30).
    const at = new Date('2026-07-27T20:00:00Z');
    expect(svc.dayKey(at, 'Asia/Kolkata')).toBe('2026-07-28');
    expect(svc.dayKey(at, 'UTC')).toBe('2026-07-27');
  });

  it('formats the local date for a zone behind UTC', () => {
    // 2026-07-27T02:00Z is 2026-07-26 22:00 in New York (-04:00).
    const at = new Date('2026-07-27T02:00:00Z');
    expect(svc.dayKey(at, 'America/New_York')).toBe('2026-07-26');
  });

  it('steps back one calendar day, including across a month boundary', () => {
    expect(svc.previousDayKey('2026-07-28')).toBe('2026-07-27');
    expect(svc.previousDayKey('2026-08-01')).toBe('2026-07-31');
    expect(svc.previousDayKey('2026-01-01')).toBe('2025-12-31');
    expect(svc.previousDayKey('2028-03-01')).toBe('2028-02-29'); // leap year
  });

  it('returns the next local midnight as an absolute instant', () => {
    const at = new Date('2026-07-27T20:00:00Z'); // 01:30 on the 28th in Kolkata
    const boundary = svc.nextBoundary(at, 'Asia/Kolkata');
    expect(boundary.getTime()).toBeGreaterThan(at.getTime());
    // The next boundary is local midnight starting 2026-07-29.
    expect(svc.dayKey(new Date(boundary.getTime() + 1000), 'Asia/Kolkata')).toBe('2026-07-29');
  });

  it('places the boundary within 24 hours', () => {
    const at = new Date('2026-07-27T20:00:00Z');
    const delta = svc.nextBoundary(at, 'Asia/Kolkata').getTime() - at.getTime();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('crosses a 25-hour civil day safely (Europe/London 2026-10-25 DST fall-back)', () => {
    // 2026-10-24T23:00Z is already local midnight starting 2026-10-25, the
    // 25-hour day created by the fall-back from BST to GMT partway through.
    const at = new Date('2026-10-24T23:00:00Z');
    expect(svc.dayKey(at, 'Europe/London')).toBe('2026-10-25');
    const boundary = svc.nextBoundary(at, 'Europe/London');
    expect(boundary.getTime()).toBeGreaterThan(at.getTime());
    // The next boundary is local midnight starting 2026-10-26, a full 25
    // hours later — well beyond the naive 24h assumption.
    expect(svc.dayKey(new Date(boundary.getTime() + 1000), 'Europe/London')).toBe('2026-10-26');
  });

  it('crosses a 23-hour civil day safely (America/New_York 2026-03-08 spring-forward)', () => {
    // 2026-03-08T05:00Z is local midnight starting 2026-03-08, the 23-hour
    // day created by the spring-forward from EST to EDT partway through.
    const at = new Date('2026-03-08T05:00:00Z');
    expect(svc.dayKey(at, 'America/New_York')).toBe('2026-03-08');
    const boundary = svc.nextBoundary(at, 'America/New_York');
    expect(boundary.getTime()).toBeGreaterThan(at.getTime());
    expect(svc.dayKey(new Date(boundary.getTime() + 1000), 'America/New_York')).toBe('2026-03-09');
  });

  it('advances exactly one calendar day for a 45-minute offset zone (Asia/Kathmandu)', () => {
    const at = new Date('2026-07-27T20:00:00Z');
    const today = svc.dayKey(at, 'Asia/Kathmandu');
    const boundary = svc.nextBoundary(at, 'Asia/Kathmandu');
    const landed = svc.dayKey(new Date(boundary.getTime() + 1000), 'Asia/Kathmandu');
    expect(svc.previousDayKey(landed)).toBe(today);
  });

  it('always lands exactly one calendar day later, across a range of zones', () => {
    const zones = ['Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Kiritimati', 'UTC'];
    const at = new Date('2026-07-27T20:00:00Z');
    for (const zone of zones) {
      const today = svc.dayKey(at, zone);
      const boundary = svc.nextBoundary(at, zone);
      const landed = svc.dayKey(new Date(boundary.getTime() + 1000), zone);
      expect(svc.previousDayKey(landed)).toBe(today);
    }
  });
});
