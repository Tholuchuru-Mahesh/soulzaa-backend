import { ATTENDANCE_LADDER_SEED, attendanceIdempotencyKey } from './attendance.constants';

describe('attendance ladder seed', () => {
  it('covers all 30 days exactly once', () => {
    const days = ATTENDANCE_LADDER_SEED.map((r) => r.day).sort((a, b) => a - b);
    expect(days).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('pays the approved cycle total', () => {
    const total = ATTENDANCE_LADDER_SEED.reduce((sum, r) => sum + r.coins, 0);
    expect(total).toBe(12_900);
  });

  it('matches the approved full ladder with all coin and EXP values pinned', () => {
    const expected = [
      { day: 1, coins: 100, expAmount: null },
      { day: 2, coins: 150, expAmount: null },
      { day: 3, coins: 200, expAmount: null },
      { day: 4, coins: 250, expAmount: null },
      { day: 5, coins: 250, expAmount: null },
      { day: 6, coins: 250, expAmount: null },
      { day: 7, coins: 500, expAmount: 100 },
      { day: 8, coins: 300, expAmount: null },
      { day: 9, coins: 300, expAmount: null },
      { day: 10, coins: 300, expAmount: null },
      { day: 11, coins: 300, expAmount: null },
      { day: 12, coins: 300, expAmount: null },
      { day: 13, coins: 300, expAmount: null },
      { day: 14, coins: 300, expAmount: null },
      { day: 15, coins: 1000, expAmount: 250 },
      { day: 16, coins: 400, expAmount: null },
      { day: 17, coins: 400, expAmount: null },
      { day: 18, coins: 400, expAmount: null },
      { day: 19, coins: 400, expAmount: null },
      { day: 20, coins: 400, expAmount: null },
      { day: 21, coins: 400, expAmount: null },
      { day: 22, coins: 400, expAmount: null },
      { day: 23, coins: 400, expAmount: null },
      { day: 24, coins: 400, expAmount: null },
      { day: 25, coins: 400, expAmount: null },
      { day: 26, coins: 400, expAmount: null },
      { day: 27, coins: 400, expAmount: null },
      { day: 28, coins: 400, expAmount: null },
      { day: 29, coins: 400, expAmount: null },
      { day: 30, coins: 2500, expAmount: 500 },
    ];
    expect(ATTENDANCE_LADDER_SEED).toEqual(expected);
  });

  it('never pays a non-positive amount', () => {
    for (const rung of ATTENDANCE_LADDER_SEED) {
      expect(rung.coins).toBeGreaterThan(0);
    }
  });

  it('builds a distinct idempotency key per user, day and kind', () => {
    expect(attendanceIdempotencyKey('u1', '2026-07-28', 'coins')).toBe(
      'attendance:u1:2026-07-28:coins',
    );
    expect(attendanceIdempotencyKey('u1', '2026-07-28', 'exp')).not.toBe(
      attendanceIdempotencyKey('u1', '2026-07-28', 'coins'),
    );
  });
});
