/** Platform-wide API constants. */
export const API_VERSION = 'v1';
export const DEFAULT_API_PREFIX = 'api';

/** Standard response messages (kept generic; domain modules add their own). */
export const API_MESSAGES = {
  OK: 'OK',
  CREATED: 'Created',
  UPDATED: 'Updated',
  DELETED: 'Deleted',
} as const;

/** Default rate-limit window/quota (enforced when a throttler is wired later). */
export const RATE_LIMIT = {
  WINDOW_SECONDS: 60,
  MAX_REQUESTS: 100,
} as const;
