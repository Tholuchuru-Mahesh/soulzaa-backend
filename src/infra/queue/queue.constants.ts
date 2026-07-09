/**
 * Central registry of queue names so names are discoverable and collision-free.
 * The seven job queues each get a worker (processor); the dead-letter queue is a
 * parking lot with no worker — exhausted jobs are routed there for inspection
 * and manual replay (see QueueSupport / QueueService.replayDeadLetter).
 */
export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  EMAILS: 'emails',
  GIFT_PROCESSING: 'gift-processing',
  RANKING_PROCESSING: 'ranking-processing',
  ANALYTICS_PROCESSING: 'analytics-processing',
  MEDIA_PROCESSING: 'media-processing',
  WALLET_PROCESSING: 'wallet-processing',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Dead-letter queue — holds jobs that exhausted their retries. No worker. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

/** The queues that have workers/processors. */
export const JOB_QUEUE_NAMES: QueueName[] = Object.values(QUEUE_NAMES);

/** Every queue to register as a producer (job queues + the DLQ). */
export const ALL_QUEUE_NAMES: string[] = [...JOB_QUEUE_NAMES, DEAD_LETTER_QUEUE];

/**
 * Worker concurrency per queue. Read at module-load so it can sit in the static
 * `@Processor` decorator; overridable via the QUEUE_CONCURRENCY env var.
 */
export const QUEUE_CONCURRENCY = Number(process.env.QUEUE_CONCURRENCY) || 5;

/** Bull Board mount path (kept here so the static module import can read it). */
export const QUEUE_DASHBOARD_ROUTE = process.env.QUEUE_DASHBOARD_ROUTE || '/admin/queues';

/**
 * Reserved job-data flag that makes the base worker throw — the deliberate hook
 * for exercising the retry → dead-letter path end-to-end. No real caller sets it.
 */
export const FORCE_FAIL_FLAG = '__forceFail';
