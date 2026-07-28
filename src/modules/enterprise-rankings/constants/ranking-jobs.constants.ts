/**
 * Repeatable-job identity for the enterprise ranking engine.
 *
 * The daily snapshot runs at 00:05 UTC — after the day has closed but before the
 * analytics rollup at 00:15, so a snapshot reflects a settled day and the two
 * never contend for the same tick.
 *
 * `JOB_ID` is fixed so BullMQ treats a redeploy (or a ten-pod fleet) as the same
 * schedule rather than stacking one repeatable job per instance.
 */
export const RANKING_SNAPSHOT_JOB = 'ranking.snapshot.daily';
export const RANKING_SNAPSHOT_CRON = '5 0 * * *';
export const RANKING_SNAPSHOT_JOB_ID = 'enterprise-ranking-snapshot-daily';

/**
 * Own queue rather than the shared RANKING_PROCESSING one, which the legacy
 * rankings module already has a worker on. Two workers on a queue are competing
 * consumers: each would take roughly half the jobs and silently no-op the half
 * belonging to the other.
 */
export const ENTERPRISE_RANKING_QUEUES = {
  SNAPSHOT: 'enterprise-ranking-snapshot',
} as const;
