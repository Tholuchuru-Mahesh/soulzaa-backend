import { RoleRequestStage, RoleRequestStatus, RoleRequestType } from '@prisma/client';

/**
 * Current pipeline shape. Stamped onto every request at submit time so a request
 * already in flight keeps being judged by the rules it entered under, even after
 * the pipeline changes underneath it.
 */
export const PIPELINE_VERSION = 1;

/**
 * The stage order a request climbs. Each stage is reviewed by the role that owns
 * the matching geography: an Official owns a region, a Country Manager owns a
 * country, and Admin is platform-wide.
 */
export const STAGE_ORDER: readonly RoleRequestStage[] = [
  RoleRequestStage.OFFICIAL,
  RoleRequestStage.MANAGER,
  RoleRequestStage.ADMIN,
];

/**
 * Which stage a request type enters at.
 *
 * Business Development bypasses the regional Official — the role is platform-wide
 * and has no regional supervisor to review it, so routing it through one would
 * ask someone to judge a scope they do not hold.
 */
export const ENTRY_STAGE: Record<RoleRequestType, RoleRequestStage> = {
  [RoleRequestType.AGENCY]: RoleRequestStage.OFFICIAL,
  [RoleRequestType.COIN_SELLER]: RoleRequestStage.OFFICIAL,
  [RoleRequestType.MODERATOR]: RoleRequestStage.OFFICIAL,
  [RoleRequestType.BUSINESS_DEVELOPMENT]: RoleRequestStage.MANAGER,
};

/** The platform role granted when a request of each type is approved. */
export const GRANTED_ROLE: Record<RoleRequestType, string> = {
  [RoleRequestType.AGENCY]: 'AGENCY',
  [RoleRequestType.COIN_SELLER]: 'COIN_SELLER',
  [RoleRequestType.MODERATOR]: 'MODERATOR',
  [RoleRequestType.BUSINESS_DEVELOPMENT]: 'BUSINESS_DEVELOPMENT',
};

/** The role permitted to act at each stage. */
export const STAGE_REVIEWER_ROLE: Record<RoleRequestStage, string> = {
  [RoleRequestStage.OFFICIAL]: 'OFFICIAL',
  [RoleRequestStage.MANAGER]: 'COUNTRY_MANAGER',
  [RoleRequestStage.ADMIN]: 'ADMIN',
};

/** Statuses from which no further action is possible. */
export const TERMINAL_STATUSES: readonly RoleRequestStatus[] = [
  RoleRequestStatus.APPROVED,
  RoleRequestStatus.REJECTED,
  RoleRequestStatus.WITHDRAWN,
  RoleRequestStatus.CANCELLED,
];

/** Statuses that occupy the "one open request per subject and type" slot. */
export const OPEN_STATUSES: readonly RoleRequestStatus[] = [
  RoleRequestStatus.SUBMITTED,
  RoleRequestStatus.IN_REVIEW,
  RoleRequestStatus.NEEDS_INFO,
];

/** The stage after `stage`, or null when `stage` is the last one. */
export function nextStage(stage: RoleRequestStage): RoleRequestStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  if (index === -1 || index === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[index + 1];
}
