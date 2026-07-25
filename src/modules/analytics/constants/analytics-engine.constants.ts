// Enterprise Reports & Analytics Engine — Phase 20 Constants

export const ANALYTICS_DOMAINS = [
  'PLATFORM_OVERVIEW',
  'FINANCIAL',
  'WALLET',
  'REVENUE',
  'GIFT',
  'TREASURE_BOX',
  'WITHDRAWAL',
  'AGENCY',
  'COIN_SELLER',
  'FAMILY',
  'VIP',
  'LEVEL',
  'ACHIEVEMENT',
  'RANKING',
  'EVENT',
  'TASK',
  'REFERRAL',
  'NOTIFICATION',
  'GROWTH',
  'RETENTION',
  'MODERATION',
] as const;
export type AnalyticsDomain = (typeof ANALYTICS_DOMAINS)[number];

export const EXPORT_FORMATS = ['CSV', 'EXCEL', 'PDF', 'JSON'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATUSES = ['PENDING', 'COMPLETED', 'FAILED'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const ANALYTICS_AUDIT_ACTIONS = [
  'REPORT_GENERATED',
  'REPORT_EXPORTED',
  'DASHBOARD_REFRESHED',
  'ANALYTICS_CONFIGURATION_UPDATED',
] as const;
export type AnalyticsAuditAction = (typeof ANALYTICS_AUDIT_ACTIONS)[number];

export const ANALYTICS_CONFIG_KEYS = {
  SNAPSHOT_INTERVAL: 'analytics.snapshot_interval',
  RETENTION_DAYS: 'analytics.retention_days',
  EXPORT_LIMIT: 'analytics.export_limit',
  DEFAULT_TIMEZONE: 'analytics.default_timezone',
  CACHE_TTL: 'analytics.cache_ttl',
} as const;
