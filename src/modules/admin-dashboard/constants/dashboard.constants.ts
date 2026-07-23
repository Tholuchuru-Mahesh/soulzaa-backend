// Enterprise Business Admin Dashboard — Phase 21 Constants

export const WIDGET_TYPES = [
  'CHART',
  'NUMBER',
  'TABLE',
  'LIST',
  'STATE',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const ALERT_SEVERITIES = [
  'INFO',
  'WARNING',
  'ERROR',
  'CRITICAL',
] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_SOURCES = [
  'DATABASE',
  'REDIS',
  'QUEUE',
  'SOCKET',
  'API',
] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];

export const DASHBOARD_AUDIT_ACTIONS = [
  'DASHBOARD_VIEWED',
  'DASHBOARD_WIDGET_UPDATED',
  'DASHBOARD_LAYOUT_UPDATED',
  'DASHBOARD_CONFIGURATION_UPDATED',
  'DASHBOARD_EXPORT_GENERATED',
] as const;
export type DashboardAuditAction = (typeof DASHBOARD_AUDIT_ACTIONS)[number];

export const DASHBOARD_CONFIG_KEYS = {
  REFRESH_INTERVAL: 'dashboard.refresh_interval',
  DEFAULT_LAYOUT: 'dashboard.default_layout',
  WIDGET_LIMIT: 'dashboard.widget_limit',
  EXPORT_LIMIT: 'dashboard.export_limit',
  CACHE_TTL: 'dashboard.cache_ttl',
} as const;
