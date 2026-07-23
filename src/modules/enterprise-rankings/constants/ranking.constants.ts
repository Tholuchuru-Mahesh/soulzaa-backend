// Enterprise Ranking Engine — Domain Constants

export const RANKING_CATEGORIES = [
  'OVERALL',
  'HOST',
  'RECEIVER',
  'GIFT_SENDER',
  'GIFT_RECEIVER',
  'AUDIO_ROOM',
  'VIDEO_ROOM',
  'FAMILY',
  'VIP',
  'LEVEL',
  'ACHIEVEMENT',
  'GAME',
  'EVENT',
  'AGENCY',
  'COIN_SELLER',
  'MODERATOR',
  'OFFICIAL',
  'SEASON',
  'COUNTRY',
  'REGION',
  'CUSTOM',
] as const;
export type RankingCategory = (typeof RANKING_CATEGORIES)[number];

export const RANKING_TIME_WINDOWS = [
  'REALTIME',
  'HOURLY',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'YEARLY',
  'SEASON',
  'LIFETIME',
] as const;
export type RankingTimeWindow = (typeof RANKING_TIME_WINDOWS)[number];

export const RANKING_ENTITY_TYPES = [
  'USER',
  'FAMILY',
  'ROOM',
  'AGENCY',
  'TEAM',
] as const;
export type RankingEntityType = (typeof RANKING_ENTITY_TYPES)[number];

export const RANKING_VISIBILITIES = ['PUBLIC', 'PRIVATE', 'ADMIN_ONLY'] as const;
export type RankingVisibility = (typeof RANKING_VISIBILITIES)[number];

export const RANKING_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type RankingStatus = (typeof RANKING_STATUSES)[number];

/** Domain event codes the ranking engine scores from */
export const RANKING_EVENT_SOURCES = [
  'GIFT_SENT',
  'GIFT_RECEIVED',
  'EXP_ADDED',
  'LEVEL_UP',
  'ACHIEVEMENT_UNLOCKED',
  'FAMILY_CONTRIBUTION',
  'VIP_PURCHASED',
  'GAME_WON',
  'EVENT_FINISHED',
  'ROOM_HOSTED',
  'ROOM_JOINED',
  'ADMIN_ADJUSTMENT',
  'MANUAL_SCORE',
] as const;
export type RankingEventSource = (typeof RANKING_EVENT_SOURCES)[number];

/** Audit action types */
export const RANKING_AUDIT_ACTIONS = [
  'RANKING_CREATED',
  'RANKING_UPDATED',
  'RANKING_PROMOTED',
  'RANKING_DEMOTED',
  'LEADERBOARD_REFRESHED',
  'RANKING_SNAPSHOT_CREATED',
  'RANKING_CONFIGURATION_UPDATED',
  'RANKING_SCORE_ADJUSTED',
] as const;
export type RankingAuditAction = (typeof RANKING_AUDIT_ACTIONS)[number];

/** Platform configuration keys */
export const RANKING_CONFIG_KEYS = {
  REFRESH_INTERVAL: 'ranking.refresh_interval',
  SNAPSHOT_INTERVAL: 'ranking.snapshot_interval',
  MAX_ENTRIES: 'ranking.max_entries',
  SCORE_DECAY: 'ranking.score_decay',
  DEFAULT_VISIBILITY: 'ranking.default_visibility',
} as const;
