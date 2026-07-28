/**
 * Repeatable-job identity for the enterprise events engine.
 *
 * Event lifecycle transitions (registration opening/closing, start, finish) are
 * time-driven, so the sweep runs every minute — a window boundary should not sit
 * unapplied long enough for a user to notice registration still "open".
 *
 * Own queue: an app-wide queue with another worker on it would make the two
 * competing consumers and silently drop half the sweeps.
 */
export const EVENT_LIFECYCLE_JOB = 'event.lifecycle.sweep';
export const EVENT_LIFECYCLE_CRON = '* * * * *';
export const EVENT_LIFECYCLE_JOB_ID = 'enterprise-event-lifecycle-sweep';

export const ENTERPRISE_EVENT_QUEUES = {
  LIFECYCLE: 'enterprise-event-lifecycle',
} as const;
