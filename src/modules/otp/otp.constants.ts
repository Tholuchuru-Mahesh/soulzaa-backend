/**
 * OTP-owned BullMQ queues. Kept separate from the platform's generic
 * `emails`/`notifications` queues so OTP delivery has dedicated workers and a
 * clean ownership boundary (the "sms_queue / email_queue" from the spec). The
 * maintenance queue carries the repeatable cleanup job.
 */
export const OTP_QUEUES = {
  SMS: 'otp-sms',
  EMAIL: 'otp-email',
  MAINTENANCE: 'otp-maintenance',
} as const;

/** BullMQ job names. */
export const OTP_JOBS = {
  DELIVER: 'otp:deliver',
  CLEANUP: 'otp:cleanup',
} as const;
