// Enterprise Referral System — Domain Constants

export const REFERRAL_CATEGORIES = [
  'USER',
  'VIP',
  'CREATOR',
  'AGENCY',
  'SELLER',
  'CAMPAIGN',
  'EVENT',
  'FAMILY',
  'PROMOTIONAL',
  'INVITE_LINK',
  'QR_CODE',
  'CUSTOM',
] as const;
export type ReferralCategory = (typeof REFERRAL_CATEGORIES)[number];

export const REFERRAL_STATUSES = [
  'CREATED',
  'SHARED',
  'REGISTERED',
  'QUALIFIED',
  'REWARDED',
  'EXPIRED',
  'REJECTED',
  'CANCELLED',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'ARCHIVED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const REFERRAL_AUDIT_ACTIONS = [
  'REFERRAL_CREATED',
  'REFERRAL_REGISTERED',
  'REFERRAL_QUALIFIED',
  'REFERRAL_REWARD_DISPATCHED',
  'REFERRAL_EXPIRED',
  'REFERRAL_CANCELLED',
  'REFERRAL_CONFIGURATION_UPDATED',
  'REFERRAL_REJECTED',
] as const;
export type ReferralAuditAction = (typeof REFERRAL_AUDIT_ACTIONS)[number];

export const REFERRAL_CONFIG_KEYS = {
  DEFAULT_EXPIRY_DAYS: 'referral.default_expiry_days',
  MAX_USES: 'referral.max_uses',
  REWARD_CLAIM_WINDOW: 'referral.reward_claim_window',
  SELF_REFERRAL_ALLOWED: 'referral.self_referral_allowed',
  QUALIFICATION_TIMEOUT: 'referral.qualification_timeout',
} as const;
