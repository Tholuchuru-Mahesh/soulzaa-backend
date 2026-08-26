/**
 * Wealth Level module constants: the lock key guarding EXP application +
 * level recompute, and the "YYYY-MM" period-key helper shared by the ledger,
 * user progress, monthly history, and reward-claim dedupe scope.
 */

/** Lock guarding a user's EXP application + level recompute. */
export function wealthLockKey(userId: string): string {
  return `wealth:user:${userId}`;
}

/** Lock guarding the monthly reset batch for a given period (single-flight across instances). */
export function wealthResetLockKey(periodKey: string): string {
  return `wealth:reset:${periodKey}`;
}

/** Current calendar month as "YYYY-MM", in UTC. */
export function currentPeriodKey(now: Date = new Date()): string {
  return periodKeyFor(now);
}

/** "YYYY-MM" for an arbitrary date, in UTC. */
export function periodKeyFor(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** The "YYYY-MM" period immediately preceding `periodKey`. */
export function previousPeriodKey(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return periodKeyFor(d);
}
