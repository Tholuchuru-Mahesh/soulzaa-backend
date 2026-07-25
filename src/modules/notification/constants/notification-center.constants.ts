// Enterprise Notification Center — Phase 19 Constants

export const NOTIFICATION_CHANNELS = ['IN_APP', 'PUSH', 'WEBSOCKET', 'EMAIL', 'SMS'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'DISPATCHED', 'FAILED', 'CANCELLED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_CENTER_TYPES = [
  'WALLET',
  'GIFT',
  'TREASURE_BOX',
  'VIP',
  'LEVEL_UP',
  'ACHIEVEMENT_UNLOCK',
  'BADGE_UNLOCK',
  'RANKING_PROMOTION',
  'EVENT_REMINDER',
  'TASK_COMPLETION',
  'MISSION_COMPLETION',
  'REFERRAL_QUALIFIED',
  'WITHDRAWAL_UPDATES',
  'FAMILY_UPDATES',
  'MODERATION_ALERT',
  'ANNOUNCEMENT',
  'SYSTEM',
] as const;
export type NotificationCenterType = (typeof NOTIFICATION_CENTER_TYPES)[number];

export const NOTIFICATION_AUDIT_ACTIONS = [
  'NOTIFICATION_CREATED',
  'NOTIFICATION_SENT',
  'NOTIFICATION_READ',
  'NOTIFICATION_FAILED',
  'NOTIFICATION_DELETED',
  'ANNOUNCEMENT_PUBLISHED',
  'NOTIFICATION_CONFIGURATION_UPDATED',
] as const;
export type NotificationAuditAction = (typeof NOTIFICATION_AUDIT_ACTIONS)[number];

export const NOTIFICATION_CONFIG_KEYS = {
  RETRY_COUNT: 'notification.retry_count',
  DEFAULT_CHANNEL: 'notification.default_channel',
  RETENTION_DAYS: 'notification.retention_days',
  BATCH_SIZE: 'notification.batch_size',
  BROADCAST_LIMIT: 'notification.broadcast_limit',
} as const;
