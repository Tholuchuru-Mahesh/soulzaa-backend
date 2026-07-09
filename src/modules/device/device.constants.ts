/**
 * Device-owned BullMQ queue for push delivery. Separate from the platform's
 * generic `notifications` queue (which has its own worker) so device login
 * alerts have a dedicated worker + clean ownership.
 */
export const DEVICE_QUEUES = {
  PUSH: 'push',
} as const;

export const DEVICE_JOBS = {
  LOGIN_ALERT: 'device:login-alert',
} as const;
