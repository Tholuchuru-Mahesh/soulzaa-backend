/** Platform-configuration keys this module reads. */
export const ATTENDANCE_CONFIG_KEYS = {
  ENABLED: 'feature.attendance.enabled',
  MIN_HOURS: 'attendance.min_hours_between_claims',
} as const;

/** Fallbacks used when a setting is absent; mirror the seeded defaults. */
export const ATTENDANCE_DEFAULTS = {
  ENABLED: true,
  MIN_HOURS: 20,
} as const;

export interface AttendanceLadderSeedRung {
  day: number;
  coins: number;
  expAmount: number | null;
}

/**
 * The approved 30-day ladder: rising, with spikes on the PRD's milestone days.
 * Cosmetics are attached by operators afterwards — the seeder leaves
 * `cosmeticId` null so the ladder never hard-depends on catalog contents.
 * Cycle total: 12,900 Game Coins.
 */
function rung(day: number): AttendanceLadderSeedRung {
  if (day === 1) return { day, coins: 100, expAmount: null };
  if (day === 2) return { day, coins: 150, expAmount: null };
  if (day === 3) return { day, coins: 200, expAmount: null };
  if (day <= 6) return { day, coins: 250, expAmount: null };
  if (day === 7) return { day, coins: 500, expAmount: 100 };
  if (day <= 14) return { day, coins: 300, expAmount: null };
  if (day === 15) return { day, coins: 1000, expAmount: 250 };
  if (day <= 29) return { day, coins: 400, expAmount: null };
  return { day, coins: 2500, expAmount: 500 };
}

export const ATTENDANCE_LADDER_SEED: readonly AttendanceLadderSeedRung[] = Array.from(
  { length: 30 },
  (_, i) => rung(i + 1),
);

/** Payout idempotency key. A retry of the same day maps to the same rows. */
export function attendanceIdempotencyKey(
  userId: string,
  dayKey: string,
  kind: 'coins' | 'exp' | 'cosmetic',
): string {
  return `attendance:${userId}:${dayKey}:${kind}`;
}
