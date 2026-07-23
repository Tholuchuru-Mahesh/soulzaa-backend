// Achievement Engine — Domain Constants
// Badge tiers, types, achievement categories, event codes, config keys

export const BADGE_TIERS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'LEGEND', 'CUSTOM'] as const;
export type BadgeTier = (typeof BADGE_TIERS)[number];

export const BADGE_TYPES = ['STANDARD', 'ANIMATED', 'SEASONAL', 'LIMITED_EDITION'] as const;
export type BadgeType = (typeof BADGE_TYPES)[number];

export const BADGE_RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const;
export type BadgeRarity = (typeof BADGE_RARITIES)[number];

export const ACHIEVEMENT_CATEGORIES = [
  'LEVEL',
  'GIFT',
  'AUDIO_ROOM',
  'VIDEO_ROOM',
  'FAMILY',
  'VIP',
  'TASK',
  'MISSION',
  'GAME',
  'EVENT',
  'REFERRAL',
  'MODERATOR',
  'ADMIN_AWARD',
  'SEASON',
  'CUSTOM',
] as const;
export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number];

export const ACHIEVEMENT_VISIBILITY = ['PUBLIC', 'HIDDEN', 'SEASONAL'] as const;
export type AchievementVisibility = (typeof ACHIEVEMENT_VISIBILITY)[number];

export const ACHIEVEMENT_STATUS = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type AchievementStatus = (typeof ACHIEVEMENT_STATUS)[number];

/** Domain event codes that the evaluation engine reacts to */
export const ACHIEVEMENT_EVENT_CODES = [
  'GIFT_SENT',
  'GIFT_RECEIVED',
  'LEVEL_UP',
  'VIP_PURCHASED',
  'FAMILY_JOINED',
  'TASK_COMPLETED',
  'MISSION_COMPLETED',
  'ROOM_JOINED',
  'ROOM_HOSTED',
  'GAME_WON',
  'REFERRAL_COMPLETED',
  'EVENT_FINISHED',
  'ADMIN_GRANTED',
  'MANUAL_AWARD',
] as const;
export type AchievementEventCode = (typeof ACHIEVEMENT_EVENT_CODES)[number];

/** Platform Configuration keys */
export const ACHIEVEMENT_CONFIG_KEYS = {
  MAX_PROGRESS: 'achievement.max_progress',
  AUTO_CLAIM: 'achievement.auto_claim',
  BADGE_DEFAULT_VISIBILITY: 'badge.default_visibility',
  REWARD_CLAIM_WINDOW: 'reward.claim_window',
} as const;

/** Audit action types */
export const ACHIEVEMENT_AUDIT_ACTIONS = [
  'ACHIEVEMENT_CREATED',
  'ACHIEVEMENT_UNLOCKED',
  'ACHIEVEMENT_PROGRESS_UPDATED',
  'BADGE_UNLOCKED',
  'BADGE_EQUIPPED',
  'BADGE_UNEQUIPPED',
  'ACHIEVEMENT_CONFIGURATION_UPDATED',
  'ACHIEVEMENT_REWARD_CLAIMED',
  'ACHIEVEMENT_MANUAL_GRANT',
] as const;
export type AchievementAuditAction = (typeof ACHIEVEMENT_AUDIT_ACTIONS)[number];
