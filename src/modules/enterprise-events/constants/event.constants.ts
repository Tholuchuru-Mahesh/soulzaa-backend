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
  'CUSTOM',
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_STATUSES = [
  'DRAFT',
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
] as const;
export type EventAuditAction = (typeof EVENT_AUDIT_ACTIONS)[number];

export const EVENT_CONFIG_KEYS = {
  MAX_PARTICIPANTS: 'event.max_participants',
  REGISTRATION_DURATION: 'event.registration_duration',
  DEFAULT_VISIBILITY: 'event.default_visibility',
  REWARD_CLAIM_WINDOW: 'event.reward_claim_window',
  AUTO_ARCHIVE_DAYS: 'event.auto_archive_days',
} as const;
