// Enterprise Events Engine — Domain Constants

export const EVENT_CATEGORIES = [
  'AUDIO_ROOM',
  'VIDEO_ROOM',
  'GIFT',
  'FAMILY',
  'VIP',
  'TOURNAMENT',
  'PK_COMPETITION',
  'GAME',
  'FESTIVAL',
  'SEASON',
  'REFERRAL_CAMPAIGN',
  'CREATOR_CAMPAIGN',
  'OFFICIAL_CAMPAIGN',
  'AGENCY_CAMPAIGN',
  'MODERATOR_CAMPAIGN',
  'PLATFORM_CHALLENGE',
  'MEETUP',
  'WORKSHOP',
  'APPRECIATION',
  'CEREMONY',
  'TALENT_SHOW',
  'COMMUNITY',
  'CUSTOM',
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_STATUSES = [
  'DRAFT',
  // Agency has submitted; awaiting Official/Admin review.
  'PENDING_APPROVAL',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'SCHEDULED',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
  'ARCHIVED',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const PARTICIPANT_STATUSES = [
  'CHECKED_IN',
  'PARTICIPATING',
  'COMPLETED',
  'DISQUALIFIED',
] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

export const EVENT_VISIBILITIES = ['PUBLIC', 'HIDDEN', 'PRIVATE', 'VIP_ONLY'] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

export const EVENT_AUDIT_ACTIONS = [
  'EVENT_CREATED',
  'EVENT_UPDATED',
  'EVENT_STARTED',
  'EVENT_COMPLETED',
  'EVENT_CANCELLED',
  'EVENT_REWARD_DISPATCHED',
  'EVENT_CONFIGURATION_UPDATED',
  'EVENT_REGISTERED',
  'EVENT_UNREGISTERED',
  'EVENT_PARTICIPATED',
  'EVENT_STATUS_CHANGED',
  'EVENT_SUBMITTED_FOR_APPROVAL',
  'EVENT_DRAFT_UPDATED',
] as const;
export type EventAuditAction = (typeof EVENT_AUDIT_ACTIONS)[number];

export const EVENT_CONFIG_KEYS = {
  MAX_PARTICIPANTS: 'events.max_participants',
  REGISTRATION_DURATION: 'events.registration_duration_hours',
  DEFAULT_VISIBILITY: 'events.default_visibility',
  REWARD_CLAIM_WINDOW: 'events.reward_claim_window_days',
  AUTO_ARCHIVE_DAYS: 'events.auto_archive_days',
} as const;

export const DEFAULT_EVENT_CONFIGS = {
  [EVENT_CONFIG_KEYS.MAX_PARTICIPANTS]: 1000,
  [EVENT_CONFIG_KEYS.REGISTRATION_DURATION]: 24,
  [EVENT_CONFIG_KEYS.DEFAULT_VISIBILITY]: 'PUBLIC',
  [EVENT_CONFIG_KEYS.REWARD_CLAIM_WINDOW]: 30,
  [EVENT_CONFIG_KEYS.AUTO_ARCHIVE_DAYS]: 90,
};
