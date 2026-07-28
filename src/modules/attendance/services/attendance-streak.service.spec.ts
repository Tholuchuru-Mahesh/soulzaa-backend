import { AttendanceDayService } from './attendance-day.service';
import { AttendanceStreakService } from './attendance-streak.service';

describe('AttendanceStreakService', () => {
  const svc = new AttendanceStreakService(new AttendanceDayService());

  const resolve = (over: Partial<Parameters<AttendanceStreakService['resolve']>[0]> = {}) =>
    svc.resolve({
      todayKey: '2026-07-28',
      lastClaimDayKey: '2026-07-27',
      currentDay: 3,
      cycleCount: 0,
      ...over,
    });

  it('starts a first-time user on day 1', () => {
    expect(resolve({ lastClaimDayKey: null, currentDay: 0 })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 0,
      reset: false,
    });
  });

  it('advances when the previous claim was yesterday', () => {
    expect(resolve()).toEqual({ kind: 'CLAIMABLE', day: 4, cycle: 0, reset: false });
  });

  it('reports an already-claimed day rather than failing', () => {
    expect(resolve({ lastClaimDayKey: '2026-07-28' })).toEqual({ kind: 'ALREADY_CLAIMED' });
  });

  it('resets to day 1 after a missed day', () => {
    expect(resolve({ lastClaimDayKey: '2026-07-26' })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 0,
      reset: true,
    });
  });

  it('resets after a long absence', () => {
    expect(resolve({ lastClaimDayKey: '2026-01-01', currentDay: 29 })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 0,
      reset: true,
    });
  });

  it('rolls day 30 into a new cycle at day 1', () => {
    expect(resolve({ currentDay: 30 })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 1,
      reset: false,
    });
  });

  it('does not increment the cycle when a streak breaks on day 30', () => {
    // A reset is not a completed cycle — only claiming day 30 then continuing is.
    expect(resolve({ currentDay: 30, lastClaimDayKey: '2026-07-20' })).toEqual({
      kind: 'CLAIMABLE',
      day: 1,
      cycle: 0,
      reset: true,
    });
  });
});
