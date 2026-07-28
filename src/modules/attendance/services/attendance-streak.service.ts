import { Injectable } from '@nestjs/common';
import { AttendanceDayService } from './attendance-day.service';

export const ATTENDANCE_CYCLE_LENGTH = 30;

export type StreakOutcome =
  { kind: 'ALREADY_CLAIMED' } | { kind: 'CLAIMABLE'; day: number; cycle: number; reset: boolean };

/**
 * Decides which rung a claim lands on. Pure: no clock, no storage — the caller
 * supplies today's key and the stored state.
 */
@Injectable()
export class AttendanceStreakService {
  constructor(private readonly days: AttendanceDayService) {}

  resolve(input: {
    todayKey: string;
    lastClaimDayKey: string | null;
    currentDay: number;
    cycleCount: number;
  }): StreakOutcome {
    const { todayKey, lastClaimDayKey, currentDay, cycleCount } = input;

    if (lastClaimDayKey === todayKey) return { kind: 'ALREADY_CLAIMED' };

    const continued = lastClaimDayKey === this.days.previousDayKey(todayKey);

    if (!continued) {
      // First-time users are not "resetting" — they're starting fresh
      const reset = lastClaimDayKey !== null;
      return { kind: 'CLAIMABLE', day: 1, cycle: cycleCount, reset };
    }

    if (currentDay >= ATTENDANCE_CYCLE_LENGTH) {
      // Completing the ladder and continuing starts the next cycle.
      return { kind: 'CLAIMABLE', day: 1, cycle: cycleCount + 1, reset: false };
    }

    return { kind: 'CLAIMABLE', day: currentDay + 1, cycle: cycleCount, reset: false };
  }
}
