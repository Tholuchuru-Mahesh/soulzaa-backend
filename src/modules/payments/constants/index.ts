/** payments constants. */

/**
 * BullMQ job names. The payments sweep rides the existing `wallet-processing`
 * queue rather than introducing an eighth queue — it is low-volume, money-domain
 * work, and every queue name in QUEUE_NAMES needs its own processor.
 */
export const PAYMENT_JOBS = {
  /** Expire stale orders + retry Play consumes that never landed. */
  RECONCILE_SWEEP: 'payments.reconcile.sweep',
} as const;

/**
 * Upper bound on how many un-consumed orders one sweep retries. Each retry is a
 * network round-trip to Google, so an unbounded batch would let a backlog stall
 * the worker for the whole cron interval. Anything left over is picked up by the
 * next tick.
 */
export const CONSUME_RETRY_BATCH_SIZE = 100;
