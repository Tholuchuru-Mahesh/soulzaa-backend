// Enterprise Tasks & Missions Engine — Domain Constants

export const TASK_CATEGORIES = [
  'DAILY_TASK',
  'WEEKLY_MISSION',
  'MONTHLY_MISSION',
  'SEASON_MISSION',
  'EVENT_MISSION',
  'FAMILY_MISSION',
  'VIP_MISSION',
  'GIFT_MISSION',
  'AUDIO_ROOM_MISSION',
  'VIDEO_ROOM_MISSION',
  'GAME_MISSION',
  'REFERRAL_MISSION',
  'CREATOR_MISSION',
  'MODERATOR_MISSION',
  'AGENCY_MISSION',
  'OFFICIAL_MISSION',
  'PLATFORM_CHALLENGE',
  'CUSTOM',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'ARCHIVED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RESET_POLICIES = ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'SEASONAL'] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

export const TASK_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD', 'EXPERT'] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

export const TASK_VISIBILITIES = ['PUBLIC', 'PRIVATE', 'HIDDEN'] as const;
export type TaskVisibility = (typeof TASK_VISIBILITIES)[number];

export const TASK_AUDIT_ACTIONS = [
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_COMPLETED',
  'MISSION_CREATED',
  'MISSION_COMPLETED',
  'TASK_EXPIRED',
  'TASK_CANCELLED',
  'TASK_REWARD_DISPATCHED',
  'TASK_CONFIGURATION_UPDATED',
  'TASK_PROGRESS_UPDATED',
] as const;
export type TaskAuditAction = (typeof TASK_AUDIT_ACTIONS)[number];

export const TASK_CONFIG_KEYS = {
  DAILY_RESET: 'task.daily_reset',
  WEEKLY_RESET: 'task.weekly_reset',
  MAX_PROGRESS: 'task.max_progress',
  REWARD_CLAIM_WINDOW: 'task.reward_claim_window',
  AUTO_CLAIM: 'task.auto_claim',
} as const;
